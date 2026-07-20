# AI 提供方（Claude、Codex、Gemini、Kimi）

Specrails 并不绑定某一个 AI。Claude、Codex、Gemini 和 Kimi 都是一流
提供方；每个界面只显示满足该功能 capability 合约的引擎。

## 四家提供方

| 提供方 | CLI | 出品方 | 说明 |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | 原生成本和持久交互 transport。 |
| **Codex** | `codex` | OpenAI | 需要 codex `0.128.0+`。从你的全局 `~/.codex/config.toml` 读取 MCP 服务器。 |
| **Gemini** | `gemini` | Google | 需要 gemini `0.11.0+`。使用原生遥测，以及 `GEMINI.md` 指令文件。 |
| **Kimi Code** | `kimi` | Moonshot AI | 需要 Kimi `0.27.0+`。Desktop 用 `-p` 启动外部 CLI，不安装或启动 server。 |

四家都是**默认启用**的。CLI 在 `PATH` 上就会显示。Kimi 请先确认
`kimi --version`，再运行 `kimi login`。

## 为一个项目安装单个提供方

添加项目时，setup 向导会问你想安装哪个（哪些）提供方。选一个，点完安装步骤，就搞定了。从那以后，这个项目就直接*拥有*了这个提供方——你再也不用去操心它。规格、rail、聊天和分析，无论你选了哪一个，用起来都一样。

如果你想要的某个 CLI 没有出现在 Add Project 里，原因几乎总是它没安装、或不在你的 `PATH` 上。装好它，再重新打开 Add Project 即可。

## 为同一个项目安装多个提供方

你可以把**不止一个**提供方装进同一个项目——比如同时用 Claude *和* Gemini。在 **Add Project** 里，提供方列表会变成一组复选框；想要哪些就勾哪些。你勾选的第一个会成为这个项目的**主**（默认）提供方，其余的则作为备选可用。

关于多提供方项目，有几点值得了解：

- **只有一个提供方时，行为和以前完全一样。** 如果一个项目只有单个提供方，你在任何地方都不会看到提供方选择器——应用保持干净、简单。
- **UI 由 capability 驱动。** Claude 和 Kimi 支持按提供方隔离的
  profile；Codex 和 Gemini 使用 legacy mode。
- **提供方在创建后就锁定了。** 在这个版本里，你在添加项目时选定提供方，之后无法再从 Settings 更改。如果你需要不同的组合，那就新建一个项目。

## 按调用逐个选择提供方

多提供方项目真正的价值，在于为每个任务挑到合适的 AI——而无需改动任何全局设置。凡是会运行 AI 的地方，都会出现一个小小的提供方选择器（仅当项目拥有不止一个提供方时）：

- **Add Spec**——Explore 支持 Kimi；Quick Spec 只显示能够保证安全
  pure-output 边界的提供方，因此不包含 Kimi。
- **rail 头部**——在启动某条具体的 rail 之前，为它挑选引擎。
- **终端**——「Open AI CLI」（Sparkles）按钮会打开一个提供方菜单，让你在该项目目录下进入任意已安装的 CLI。

你的选择会按项目被记住，默认是主提供方，所以你不用每次都重新选。

## Capability 差异

Kimi 支持 Project/Agent Chat、Explore/proposal、Quick Launcher
（`/opsx:ff`）、rail、Freestyle、没有 Decider 的 loop、profile/手动 role、
MCP、Serena、terminal 和附件。

`kimi -p` 会自动批准工具，无法强制 no-tools/read-only 边界。因此
Quick Spec、AI Edit、Contract Refine、SMASH/Re-SMASH、Project Builder
blueprint/milestone 生成、Loop Decider、文件摘要/construction story 和
Agent Studio automation 都会在 spawn 前拒绝。AI auto-title 使用确定性
fallback。详见 [Kimi 指南](../../../kimi.md)。

## 跨提供方的成本追踪

**Analytics** 记录实际启动的调用。Claude 报告成本，Codex/Gemini
使用估算。Kimi 不报告 authoritative token 或 USD cost，因此这些字段
保持为空。

## 疑难排查

- **我装了某个提供方，却没出现在选项里。** 检查 `claude --version` / `codex --version` / `gemini --version` / `kimi --version`。
- **聊天里没加载 Codex 的 MCP 服务器。** Codex 从你的全局 `~/.codex/config.toml` 读取 MCP 服务器——用 `codex mcp add` 在那里注册它们。
- **紧急停用。** 可以通过环境变量在应用范围内关闭某个提供方（`SPECRAILS_CODEX_BETA=0` 或 `SPECRAILS_GEMINI_BETA=0`）。这只会把提供方从*选择列表*中隐藏；很少会用到。

## 另见

请参阅 [Kimi 指南](../../../kimi.md)、Codex 指南和 Gemini 指南。
