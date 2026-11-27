# Kiro Usage

[![Release](https://img.shields.io/github/v/release/MOLUOGH/toys-for-kiro?label=release)](https://github.com/MOLUOGH/toys-for-kiro/releases/latest)
[![Open VSX](https://img.shields.io/open-vsx/v/moluogh/toys-for-kiro?label=Open%20VSX)](https://open-vsx.org/extension/moluogh/toys-for-kiro)
[![License: MIT](https://img.shields.io/github/license/MOLUOGH/toys-for-kiro)](https://github.com/MOLUOGH/toys-for-kiro/blob/main/LICENSE)
![Platform: Windows | macOS | Linux](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d4)

**English** | [简体中文](https://github.com/MOLUOGH/toys-for-kiro/blob/main/README.zh-CN.md)

An unofficial local usage & quota dashboard for Kiro IDE (formerly Toys for Kiro). See how many credits each session used, how full its context is, where your monthly quota stands, and how fast each request was. It reads Kiro's local session records and logs only: it does not modify Kiro, does not go online, and uploads nothing.

> **中文说明**：Kiro IDE 的非官方本地用量、额度与上下文统计面板（原 Toys for Kiro），纯离线读取本机会话记录与日志，不联网、不上传任何数据。扩展界面默认自动跟随 Kiro 显示中文，完整文档请参阅 **[简体中文版 (README.zh-CN.md)](https://github.com/MOLUOGH/toys-for-kiro/blob/main/README.zh-CN.md)**。

> Unofficial project, not affiliated with or endorsed by AWS. Kiro is a trademark of Amazon.com, Inc. or its affiliates.
> The local file formats it reads are undocumented, so a Kiro update may require changes.

<p align="center">
  <img src="https://raw.githubusercontent.com/MOLUOGH/toys-for-kiro/main/docs/images/en/overview.png" alt="Usage overview" width="860">
</p>

<sub>Screenshots use made-up demo data.</sub>

## Features

- **Status bar**: context usage of the current session (highlights yellow at ≥ 75% and red at ≥ 90%) paired with a configurable metric (`session` credits, `today` credits, or `cycle` quota %). Hover for turns, requests, tool calls, credits (including subagents and auxiliary calls), estimated tokens, time to first token, model and tool time, visible output speed, today and cycle totals, plus quick links to **Dashboard · Export · Settings**.
- **Overview**: requests, estimated tokens, credits and their USD equivalent; a usage heatmap (cells from 5 minutes to 1 day, chosen to fit the time range); a model health timeline; usage by model.
- **Requests**: every request, filterable by model, session and status, with context usage, time to first token, duration, error type, retries and fallbacks.
- **Sessions**: a session list with search (title, workspace, model), current-workspace filter, and full statistics for any session.
- **Quota**: plan, used and limit for this cycle, daily pace and end-of-cycle projection, bonus credits, reset time, and daily credits on this machine.
- **Data export**: export requests, sessions, or daily credits to CSV (UTF-8 BOM for Excel), or export a full JSON usage report.
- **Privacy switch**: keep statistics in memory only, with nothing written to disk.
- **Chinese and English UI**: follows Kiro's display language by default; can be set explicitly.
- Imports sessions in the pre-1.0 Kiro format.

<table>
  <tr>
    <td><img src="https://raw.githubusercontent.com/MOLUOGH/toys-for-kiro/main/docs/images/en/sessions.png" alt="Session statistics"></td>
    <td><img src="https://raw.githubusercontent.com/MOLUOGH/toys-for-kiro/main/docs/images/en/requests.png" alt="Request history"></td>
  </tr>
  <tr>
    <td align="center">Session statistics</td>
    <td align="center">Request history</td>
  </tr>
</table>

## Install

Requires Kiro IDE (Windows, macOS, or Linux).

**From the Extensions view (recommended)**: search for `Kiro Usage` in Kiro's Extensions view and click Install.

**Manually**:
1. Download `toys-for-kiro-<version>.vsix` from [Releases](https://github.com/MOLUOGH/toys-for-kiro/releases/latest).
2. In Kiro, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`), run `Extensions: Install from VSIX...` and pick the file.
   Or from a terminal:
   ```powershell
   # Windows
   & "<Kiro install dir>\bin\kiro.cmd" --install-extension toys-for-kiro-<version>.vsix
   # macOS / Linux
   kiro --install-extension toys-for-kiro-<version>.vsix
   ```

Then run `Developer: Reload Window`. A pie-chart icon appears on the right of the status bar; click it to open the dashboard.

To uninstall, remove Kiro Usage in the Extensions view. Its index lives under Kiro's user-data folder in `User/globalStorage/moluogh.toys-for-kiro` (`%APPDATA%\Kiro` on Windows, `~/Library/Application Support/Kiro` on macOS, `~/.config/Kiro` on Linux); you can delete that folder afterwards.

## How accurate are the numbers

| Metric | Source | Accuracy |
|---|---|---|
| Credits | `creditSplit` in the session records (metering returned by Kiro's servers) | Close to exact. Checked against the used amount from Kiro's quota API: within about 1.6%. The gap comes from the delay between quota refreshes and local writes, and from usage not recorded on this machine |
| Context usage % | `context_usage_percentage` returned by the server | Exact |
| Input tokens | Context usage % × context window | The window size is not available locally; 1,000,000 is assumed (Kiro uses the same value when it does not know a model's window). If the window is wrong, all input tokens are off by the same factor. Can be set per model |
| Output tokens | Estimated from visible text (replies and tool-call arguments) | Low. Kiro only keeps thinking summaries, so full thinking tokens are not visible |
| Time to first token, duration, errors | Kiro log lines `q.converse.model_call_attempt` | Exact. Kiro only keeps the logs of the last ~10 launches; this extension copies them into its own index |
| USD | Credits × price | Uses the overage rate from the quota API ($0.04) by default, not your plan's actual price |
| Cache hit rate | — | Not returned by Kiro's backend, so it cannot be measured |

## Privacy and storage

- Reads local files only. No network access, no API calls, no login tokens.
- The index stores numbers and session titles only, never conversation content or account IDs.

Credits, context usage and tokens are computed from Kiro's own session files, which Kiro keeps. Only time to first token, duration and errors come from Kiro's logs, and Kiro keeps just the last ~10 launches of those.

| Mode | Writes to disk | Credits / tokens | Latency and error history |
|---|---|---|---|
| `disk` (default) | This extension's index file, a few hundred KB | Complete | Kept from the day you install it (limit with `retentionDays`) |
| `memory` | Nothing | Complete | Only the logs Kiro still keeps |

- In `memory` mode every window start rescans in the background, usually in a few seconds. When you switch from `disk` to `memory`, the extension offers to delete the saved index.
- `Kiro Usage: Clear Local Data` deletes the index file. In `disk` mode it is rebuilt right away from Kiro's current files; records from logs Kiro has already deleted are lost for good. If another Kiro window has the file open, Windows will not allow deleting it, so the extension empties it instead.

<details>
<summary>Files it reads</summary>

`<Kiro user-data>` is `%APPDATA%\Kiro` on Windows, `~/Library/Application Support/Kiro` on macOS, and `$XDG_CONFIG_HOME/Kiro` (`~/.config/Kiro` by default) on Linux.

| Location | Contents |
|---|---|
| `~/.kiro/sessions/*/sess_*/session.json`, `messages.jsonl` | Session metadata; credits and context usage per request; request IDs per turn |
| `<Kiro user-data>/logs/*/window*/exthost/kiro.kiroAgent/Kiro Logs.log` | Duration and outcome of each model call (only these log lines are read) |
| `q-client.log` in the same folder | Responses of the quota API (account IDs are not stored) |
| `<Kiro user-data>/User/globalStorage/state.vscdb` | Quota data cached by Kiro (opened read-only) |
| `<Kiro user-data>/User/globalStorage/kiro.kiroagent/` | Sessions in the pre-1.0 format |

</details>

## Settings

Click the gear icon at the top right of the dashboard (or on the editor tab title bar), **Settings** in the status bar hover card, or run `Kiro Usage: Open Settings` from the Command Palette to open all extension settings:

| Setting | Default | Description |
|---|---|---|
| `toysForKiro.language` | auto | UI language: `auto` follows Kiro, `zh-CN` Chinese, `en` English |
| `toysForKiro.contextWindowTokens` | 1000000 | Context window used to turn usage percentages into tokens |
| `toysForKiro.modelContextWindows` | `{}` | Per-model context windows |
| `toysForKiro.creditPriceUsd` | 0 | USD per credit; 0 uses the overage rate |
| `toysForKiro.importLegacySessions` | true | Import and show pre-1.0 sessions |
| `toysForKiro.storage.mode` | disk | `disk` keeps the index; `memory` keeps statistics in memory only |
| `toysForKiro.storage.retentionDays` | 0 | Days to keep latency and error records; 0 keeps them forever |
| `toysForKiro.statusBar.enabled` | true | Show the status bar item |
| `toysForKiro.statusBar.mode` | session | Status bar metric: `session` credits, `today` credits, or `cycle` quota % |
| `toysForKiro.refreshIntervalSeconds` | 5 | Seconds between scans |
| `toysForKiro.defaultRange` | cycle | Default time range of the dashboard |

Command and setting names follow Kiro's display language. `toysForKiro.language` controls the dashboard, the status bar and dialogs.

## Limitations

- Primarily tested on Windows; macOS and Linux use Kiro's standard Electron user-data directories.
- The "current session" is the most recently active session in the current workspace. With several sessions open, it may not be the one you are looking at.
- Legacy sessions have no credits, and their input tokens are estimated once per run from the final context, so they read low.
- For the turn in progress, request IDs are only written when the turn ends. Until then, latency data is matched to the log by time order.

## License

[MIT](https://github.com/MOLUOGH/toys-for-kiro/blob/main/LICENSE)
