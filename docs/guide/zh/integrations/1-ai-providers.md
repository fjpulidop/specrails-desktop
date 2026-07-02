# AI 提供方（Claude、Codex、Gemini）

Specrails 并不绑定在某一个 AI 上。应用里所有会调用 AI 的环节——Explore Spec、Quick spec、rail、聊天、AI Edit，以及终端里的「Open AI CLI」按钮——都可以走三家一流提供方中的任意一家。你来决定每个项目用哪些，甚至可以按任务逐个切换。

## 三家提供方

| 提供方 | CLI | 出品方 | 说明 |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | 功能最完整。Agents（profile）、Freestyle rail 以及 Contract Refine 都只有它支持。 |
| **Codex** | `codex` | OpenAI | 需要 codex `0.128.0+`。从你的全局 `~/.codex/config.toml` 读取 MCP 服务器。 |
| **Gemini** | `gemini` | Google | 需要 gemini `0.11.0+`。使用原生遥测，以及 `GEMINI.md` 指令文件。 |

三家都是**默认启用**的。只要某家提供方的 CLI 已安装并在你的 `PATH` 上，它就会出现在 **Add Project** 里。所以第一步永远是一样的：按那个工具自己的文档把你想用的 CLI 装好并登录。一旦 `claude --version`（或 `codex`、`gemini`）能在你的终端里正常运行，Specrails 就能用它了。

## 为一个项目安装单个提供方

添加项目时，setup 向导会问你想安装哪个（哪些）提供方。选一个，点完安装步骤，就搞定了。从那以后，这个项目就直接*拥有*了这个提供方——你再也不用去操心它。规格、rail、聊天和分析，无论你选了哪一个，用起来都一样。

如果你想要的某个 CLI 没有出现在 Add Project 里，原因几乎总是它没安装、或不在你的 `PATH` 上。装好它，再重新打开 Add Project 即可。

## 为同一个项目安装多个提供方

你可以把**不止一个**提供方装进同一个项目——比如同时用 Claude *和* Gemini。在 **Add Project** 里，提供方列表会变成一组复选框；想要哪些就勾哪些。你勾选的第一个会成为这个项目的**主**（默认）提供方，其余的则作为备选可用。

关于多提供方项目，有几点值得了解：

- **只有一个提供方时，行为和以前完全一样。** 如果一个项目只有单个提供方，你在任何地方都不会看到提供方选择器——应用保持干净、简单。
- **右侧边栏只显示所有已安装提供方都支持的板块。** 因为 Agents（profile）是 Claude 独有的概念，所以一旦项目里包含任何非 Claude 的提供方，**Agents** 板块就会消失。其余的（Specs、Code、Analytics、Integrations、Terminal、Chat）都会保留。
- **提供方在创建后就锁定了。** 在这个版本里，你在添加项目时选定提供方，之后无法再从 Settings 更改。如果你需要不同的组合，那就新建一个项目。

## 按调用逐个选择提供方

多提供方项目真正的价值，在于为每个任务挑到合适的 AI——而无需改动任何全局设置。凡是会运行 AI 的地方，都会出现一个小小的提供方选择器（仅当项目拥有不止一个提供方时）：

- **Add Spec**——有一个引擎选择器，让你用喜欢的提供方来 Explore 或 Quick 生成规格。
- **rail 头部**——在启动某条具体的 rail 之前，为它挑选引擎。
- **终端**——「Open AI CLI」（Sparkles）按钮会打开一个提供方菜单，让你在该项目目录下进入任意已安装的 CLI。

你的选择会按项目被记住，默认是主提供方，所以你不用每次都重新选。

## 只有 Claude 才能做的事

有少数功能天生就是 Claude 专属的，因此当其他提供方参与时，它们要么被隐藏、要么被跳过：

- **Agents（profile）**——按项目的 agent 目录与模型路由。在任何包含非 Claude 提供方的项目上都会隐藏。
- **Freestyle rail**——始终在 Claude 上运行。
- **Contract Refine**——对已提交规格追加的「Contract Layer」环节，只有当对话的提供方是 Claude 时才会运行。
- **Add Spec 高级模式**（SMASH / Contract Layer）——对非 Claude 引擎隐藏。

其余的一切——Explore、Quick spec、完整的 rail 流水线、AI Edit、聊天、成本分析——三家全都能用。

## 跨提供方的成本追踪

**Analytics** 页面会追踪每一次产生费用的调用，无论用的是哪家提供方。在多提供方项目上，它还会加上引擎筛选标签，方便你按提供方对比开销。Claude 会报告自己的精确成本；而对 Codex 和 Gemini，Specrails 会用内置的费率表来估算成本，所以那些数字是接近的近似值，而非实际账单金额。

## 疑难排查

- **我装了某个提供方，却没出现在选项里。** 确认该 CLI 在你的 `PATH` 上（在一个全新终端里试试 `claude --version` / `codex --version` / `gemini --version`）。应用是通过你系统的 `PATH` 来探测提供方 CLI 的。
- **聊天里没加载 Codex 的 MCP 服务器。** Codex 从你的全局 `~/.codex/config.toml` 读取 MCP 服务器——用 `codex mcp add` 在那里注册它们。
- **紧急停用。** 可以通过环境变量在应用范围内关闭某个提供方（`SPECRAILS_CODEX_BETA=0` 或 `SPECRAILS_GEMINI_BETA=0`）。这只会把提供方从*选择列表*中隐藏；很少会用到。

## 另见

各提供方的专属指南会对每个 CLI 讲得更深入：Codex 指南和 Gemini 指南都涵盖了安装设置、能做什么，以及各自特有的小脾气。
