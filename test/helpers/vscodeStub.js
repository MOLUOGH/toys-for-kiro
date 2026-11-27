'use strict';

// Minimal stand-in for the `vscode` module, enough to activate the extension in Node.

const path = require('path');
const Module = require('module');

function createStub() {
  const commands = new Map();
  const executed = [];
  const statusItems = [];
  const panels = [];
  const config = {};
  const listeners = { config: [] };
  const answers = [];
  const messages = [];

  class Uri {
    constructor(fsPath) {
      this.fsPath = fsPath;
      this.scheme = 'file';
    }
    static file(p) {
      return new Uri(p);
    }
    static joinPath(base, ...parts) {
      return new Uri(path.join(base.fsPath, ...parts));
    }
    toString() {
      return `file://${this.fsPath}`;
    }
  }

  class MarkdownString {
    constructor(v = '') {
      this.value = v;
    }
    appendMarkdown(s) {
      this.value += s;
      return this;
    }
    appendText(s) {
      this.value += s;
      return this;
    }
  }

  class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  }

  const disposable = () => ({ dispose() {} });

  function createWebviewPanel(viewType, title) {
    const received = [];
    const posted = [];
    let onMessage = null;
    const panel = {
      viewType,
      title,
      visible: true,
      iconPath: null,
      posted,
      received,
      webview: {
        html: '',
        cspSource: 'vscode-resource:',
        asWebviewUri: (u) => u,
        postMessage: async (m) => {
          posted.push(m);
          return true;
        },
        onDidReceiveMessage: (fn) => {
          onMessage = fn;
          return disposable();
        },
      },
      send: (m) => onMessage && onMessage(m),
      reveal() {},
      onDidChangeViewState: () => disposable(),
      onDidDispose: () => disposable(),
    };
    panels.push(panel);
    return panel;
  }

  const vscode = {
    Uri,
    MarkdownString,
    ThemeColor,
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1 },
    ProgressLocation: { Window: 10, Notification: 15 },
    window: {
      createOutputChannel: () => ({ info() {}, warn() {}, error() {}, appendLine() {}, dispose() {} }),
      createStatusBarItem: () => {
        const item = { text: '', tooltip: '', command: null, name: '', backgroundColor: undefined, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
        statusItems.push(item);
        return item;
      },
      createWebviewPanel,
      state: { focused: true },
      showErrorMessage: async (m) => {
        messages.push({ kind: 'error', text: m });
        if (!stub.allowErrors) throw new Error(`showErrorMessage: ${m}`);
        return undefined;
      },
      // Dialogs return the next scripted answer (undefined = dismissed).
      showWarningMessage: async (m) => {
        messages.push({ kind: 'warning', text: m });
        return answers.shift();
      },
      showInformationMessage: async (m, ...items) => {
        messages.push({ kind: 'info', text: m });
        return items.length ? answers.shift() : undefined;
      },
      showQuickPick: async (items) => {
        const next = answers.shift();
        if (typeof next === 'string') return items.find((i) => i.id === next || i.label === next);
        return next;
      },
      showSaveDialog: async (opts) => {
        const next = answers.shift();
        if (typeof next === 'string') return Uri.file(next);
        return next === true ? opts.defaultUri : next;
      },
      withProgress: async (_o, fn) => fn({ report() {} }),
    },
    env: { language: 'zh-cn' },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d) }),
      onDidChangeConfiguration: (fn) => {
        listeners.config.push(fn);
        return disposable();
      },
      onDidChangeWorkspaceFolders: () => disposable(),
    },
    commands: {
      registerCommand: (id, fn) => {
        commands.set(id, fn);
        return disposable();
      },
      executeCommand: async (id, ...args) => {
        executed.push({ id, args });
        const fn = commands.get(id);
        return fn ? fn(...args) : undefined;
      },
    },
  };
  const stub = { vscode, commands, executed, statusItems, panels, config, answers, messages, allowErrors: false };
  return stub;
}

/** Load src/extension.js fresh so it binds to the currently installed stub. */
function loadExtension() {
  const src = path.join(__dirname, '..', '..', 'src') + path.sep;
  for (const k of Object.keys(require.cache)) if (k.startsWith(src)) delete require.cache[k];
  return require(path.join(src, 'extension.js'));
}

/** Make `require('vscode')` return the stub while `fn` runs module loading. */
function installStub(stub) {
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return stub.vscode;
    return original.call(this, request, ...rest);
  };
  return () => {
    Module._load = original;
  };
}

module.exports = { createStub, installStub, loadExtension };
