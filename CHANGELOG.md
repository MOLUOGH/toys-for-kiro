# Changelog / 更新日志

## 0.5.0

### English

- **Rebranded to Kiro Usage with a Kiro-inspired icon**: redesigned the extension icon, editor tab icon, and dashboard header mark with a stylized Kiro ghost, quota gauge arc, and usage bars; refined Marketplace search keywords and summary. Extension ID (`moluogh.toys-for-kiro`) and settings prefix (`toysForKiro.*`) remain unchanged for seamless upgrades.
- **Streamlined settings & quick actions**: added Settings, Export, and Refresh buttons to the dashboard top bar and editor tab title bar (`...` menu includes Rebuild Index and Clear Local Data), added quick-action links (**Dashboard · Export · Settings**) to the status bar hover card, and added the `Kiro Usage: Open Settings` command.
- **Usage data export**: export request history, session summaries, or daily credits to CSV (with UTF-8 BOM for Excel), or export a full JSON usage report with quota forecasts via the dashboard button, status bar hover link, or `Kiro Usage: Export Usage Data`.
- **Customizable status bar modes**: new `toysForKiro.statusBar.mode` setting switches between current-session credits (`session`, default), today's credits (`today`), and billing-cycle quota percentage (`cycle`), each clicking through to its matching view, plus today's summary in the hover tooltip.
- **macOS & Linux path support**: resolves Kiro directories on macOS (`~/Library/Application Support/Kiro`) and Linux (`$XDG_CONFIG_HOME/Kiro` or `~/.config/Kiro`), handles `file://` workspace URIs, and preserves case-sensitive path matching on Linux.
- **Multilingual docs & changelog**: `README.md` now defaults to English (with a Chinese overview note and link to `README.zh-CN.md`), and `CHANGELOG.md` is now bilingual in English and Simplified Chinese.

### 简体中文

- **更名为 Kiro Usage 并融入 Kiro 图标元素重绘标识**：全新设计扩展图标、标签页图标与面板顶栏标识（融合风格化 Kiro 幽灵形象、额度仪表弧线与用量柱状图），优化扩展市场搜索词与简介展示；扩展 ID（`moluogh.toys-for-kiro`）与设置项前缀（`toysForKiro.*`）保持不变，已安装用户可直接平滑升级。
- **优化设置与快捷入口**：面板右上角与编辑器标签栏（`editor/title`）新增设置、导出、刷新按钮（`...` 菜单含重建索引与清除本地数据），状态栏悬停卡片新增快捷操作栏（**用量面板 · 导出数据 · 设置**），并新增命令 `Kiro Usage: 打开设置`。
- **支持导出用量数据**：可通过面板右上角导出按钮、状态栏悬停链接或命令 `Kiro Usage: 导出用量数据`，将请求明细、会话汇总、每日用量导出为 CSV（带 UTF-8 BOM，Excel 可直接打开），或导出包含完整统计与额度预测的 JSON 报告。
- **状态栏显示模式可定制**：新增设置 `toysForKiro.statusBar.mode`，支持切换显示「当前会话 credits」（默认）、「今日累计 credits」或「本计费周期额度占比」，点击后分别打开对应视图，悬停提示新增今日汇总。
- **补齐 macOS 与 Linux 路径兼容**：支持解析 macOS（`~/Library/Application Support/Kiro`）和 Linux（`$XDG_CONFIG_HOME/Kiro` 或 `~/.config/Kiro`）的本地目录，兼容 `file://` 工作区 URI，并在 Linux 下保留路径大小写敏感匹配。
- **双语文档与更新日志**：默认 `README.md` 改为英文（顶部附中文说明及 `README.zh-CN.md` 完整中文文档链接），`CHANGELOG.md` 改为中英双语。

## 0.4.0

### English

- **High context usage alerts in the status bar**: highlights with a warning background at ≥ 75% context usage and an error background at ≥ 90%.
- **Daily pace & forecast on the Quota tab**: shows average daily credits for the current billing cycle and projects end-of-cycle usage or estimated days until exhaustion at the current pace.
- **Session search & workspace filter**: added a search box (filters by title, workspace, or model) and a "Current workspace only" toggle on the Sessions tab.
- **Streamlined README**: removed maintainer-only build and release instructions from the extension details page.

### 简体中文

- **状态栏高上下文占用提醒**：当前会话上下文占用达到 75% 时显示警告背景，达到 90% 时显示错误背景。
- **额度页新增「日均消耗」卡片**：展示本计费周期的日均 credits，并按当前速度估算周期末预计用量或预计用完天数。
- **会话页搜索与筛选**：新增搜索框（可按标题、工作区、模型过滤）和「仅当前工作区」开关。
- **精简扩展详情页 README**：移除面向开发者的构建与发版说明。

## 0.3.0

### English

- **English UI**: added `toysForKiro.language` (`auto` by default to follow Kiro's display language, `zh-CN`, or `en`); changing it updates the dashboard and status bar immediately.
- **Localized commands and settings**: command titles and configuration descriptions now support both English and Chinese based on Kiro's display language.
- **Bilingual READMEs**: added an English README alongside the Chinese README with a language switcher at the top.
- **Automatic legacy session refresh**: rescans local sessions once on upgrade (a few seconds) to update legacy session display titles.

### 简体中文

- **新增英文界面**：新增设置 `toysForKiro.language`（`auto` 默认跟随 Kiro 显示语言、`zh-CN`、`en`），修改后面板和状态栏立即切换。
- **命令与设置项本地化**：命令和设置项的名称同步提供中英文版本，跟随 Kiro 的显示语言。
- **新增英文 README**：提供中英文 README 并在顶部支持互相切换。
- **自动刷新旧版会话标题**：升级后自动重新解析一次本地会话（几秒钟），以更新旧版会话的显示名称。

## 0.2.3

### English

- **UTC billing-cycle dates**: billing-cycle dates now display in UTC to match Kiro (e.g. `11/1 – now (resets 12/1)` instead of shifting a day earlier in time zones west of UTC). The underlying query range is unchanged.
- **Explicit reset time & UTC daily buckets**: the Quota tab shows both `00:00 UTC` and the corresponding local reset time, and daily credits are grouped by UTC calendar day to match the billing cycle.
- **Bonus credit expiry year**: displays the year when a bonus credit's expiry date falls outside the current year.

### 简体中文

- **计费周期日期改按 UTC 显示**：与 Kiro 保持一致，周期从每月 1 号开始显示为「11/1 – 现在（12/1 重置）」，修复了 UTC 以西时区换算为本地时间后显示成前一天的问题；统计范围本身不变。
- **明确重置时刻与每日分组**：额度页写明重置时刻（UTC 0 点）和对应的本地时间；每日 credits 按 UTC 日期分组，对应周期的每一天。
- **跨年奖励额度到期日**：奖励额度的到期日期不在当年时显示年份。

## 0.2.2

### English

- **Published on Open VSX**: can now be searched and installed directly from Kiro's Extensions view.
- **Rewritten README**: added demo screenshots, an English summary, and installation instructions from the Extensions view or GitHub Releases.
- **Automated releases**: GitHub Actions now runs tests, packages the VSIX, creates the GitHub Release, and publishes to Open VSX on tag push.
- No functional changes to the extension itself.

### 简体中文

- **首次发布到 Open VSX**：可以直接在 Kiro 的扩展面板里搜索安装。
- **重写 README**：加入演示数据截图、英文简介，安装步骤改为从扩展面板或 Releases 安装。
- **自动化发版**：改由 GitHub Actions 自动完成测试、打包、创建 Release 与发布到 Open VSX。
- 扩展本身的功能没有变化。

## 0.2.1

### English

- **Fixed usage heatmap layout**: ranges like Billing cycle and Last 30 days previously drew only a few columns with wide gaps. The heatmap now always uses 7 rows and up to 53 columns, automatically picking a cell size from 5 minutes to 1 day to fill the full width.
- **Heatmap legend & tooltips**: shows the cell duration and color legend below the heatmap, and shows each cell's start/end time on hover.
- **Full-day "Today" view**: "Today" spans the full calendar day and leaves future hours blank.

### 简体中文

- **修复用量热力图布局**：修复计费周期、最近 30 天等范围只画出几列、格子之间留出大片空白的问题。现在热力图固定 7 行、最多 53 列，按时间范围自动选择每格大小（5 分钟到 1 天），始终铺满宽度。
- **热力图图例与悬停提示**：下方显示每格代表的时间跨度和颜色图例；悬停显示每格的起止时间。
- **「今天」按整天展示**：还没到的时间留空。

## 0.2.0

### English

- **Initial public release**.
- **Status bar**: live context usage and credits for the active session, with session statistics on hover.
- **Usage dashboard**: Overview (requests, estimated tokens, credits, heatmap, model health, usage distribution), Requests, Sessions, and Quota tabs.
- **Legacy session import**: imports pre-1.0 Kiro sessions.
- **Privacy & storage controls**: `disk` (default) or `memory` (writes nothing to disk) storage modes, configurable retention days for latency/error logs, and the Clear Local Data command.

### 简体中文

- **首个公开版本**。
- **状态栏**：显示当前会话的上下文占用和 credits，悬停显示会话统计。
- **用量面板**：概览（请求、估算 token、credits、热力图、模型健康、用量分布）、请求记录、会话、额度。
- **旧版兼容**：导入 Kiro 1.0 之前的旧格式会话。
- **隐私与存储控制**：存储模式支持 `disk`（默认）或 `memory`（不写入磁盘）；支持设置延迟和错误记录保留天数，以及清除本地数据命令。
