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

## 提供方自动检测

你永远不需要按项目挑选提供方。specrails 会检测你机器上安装的每个提供方 CLI，并让**所有**项目始终可以使用**全部**提供方。之后各个界面会检查提供方声明的能力。Kimi 的确切能力矩阵参见[使用 Kimi](../../../kimi.md)。

如果你想要的提供方哪里都没出现，几乎总是因为该 CLI 未安装或不在 `PATH` 中。安装并登录后切回应用 — 检测会在窗口获得焦点时重新运行，该提供方会自动出现在所有地方，其项目 workspace 也会在后台组装完成。已安装但未登录的提供方仍会出现，只是在引擎选择器上带有*未登录*标记。

关于多提供方机器的几点说明：

- **只有一个提供方时行为与从前完全一致。** 只检测到一个提供方时，你不会在任何地方看到提供方选择器 — 应用保持干净简洁。
- **能力决定侧边栏。** 只要至少一个已检测的提供方支持某个版块，它就可见；版块内与引擎相关的操作只会提供有能力的提供方。Kimi 声明了配置文件、自定义角色和 Freestyle；不声明需要可强制执行的无工具边界的结构化操作。
- **没有任何锁定。** 安装或移除某个提供方 CLI 会自动更新所有项目 — 不存在需要管理的按项目提供方设置。

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
