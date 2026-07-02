# 为每条 rail 选择引擎

Specrails desktop 把 **Claude Code**、**Codex CLI** 和 **Gemini CLI** 都当作一等公民的引擎。一个项目可以装其中一个、两个，或三个全装——而当装的不止一个时，你就能为每条 rail 选择用哪个引擎。本页讲解按 rail 的引擎选择器，以及什么时候该选哪一个。

## 选择器何时出现

**引擎选择器**就在 rail 头部，紧挨着模式控件。只有当项目装了**不止一个**提供方时它才会出现。

> **单提供方项目的行为逐字节一致。** 如果一个项目只装了一个引擎，就不会显示选择器，提供方选择相关的一切也都不会变——它就直接在那个引擎上跑。这个选择器纯粹是给多提供方项目用的。

当它确实出现时，你的选择是**按 rail、按每次启动**生效的——不同的 rail 可以跑不同的引擎，而你的选择会按项目记住（默认为项目的主引擎）。

## 如何选择一个引擎

1. 确认这条 rail 的引擎选择器正在显示（项目有 2 个及以上提供方）。
2. 点开它，选 **Claude**、**Codex** 或 **Gemini**。
3. 用 **▶ Play** 启动这条 rail。

被选中的引擎会跑这条 rail 流水线的每一个阶段。如果所选引擎对应的 CLI 没装，启动会快速失败——什么都不会启动。装上缺失的 CLI 再试一次即可。

## 每个引擎擅长什么

三者都能跑标准的 **Implement** 和 **Batch** 流水线。下面是一份实用的选择指南：

| 引擎 | 在什么情况下选它…… | 说明 |
|--------|--------------------|-------|
| **Claude** | 你想要全套功能：Agent Profile、Freestyle、原生成本上报、最丰富的工具支持。大多数工作的默认之选。 | 唯一支持 **Agent Profile**、**Freestyle** 以及几个 Claude 专属 spec 功能（Contract Layer、SMASH）的引擎。 |
| **Codex** | 你更喜欢 OpenAI Codex CLI，或想跨提供方对比实现。 | `codex` ≥ 0.128.0。无原生成本上报——应用会用自己的价格表来补上成本。Profile 不适用。 |
| **Gemini** | 你想用 Google 的 Gemini CLI、原生遥测，或为常规 spec 跑得更省钱。 | `gemini` ≥ 0.11.0（需设置 `GEMINI_API_KEY`）。原生 OTLP 遥测。Profile 不适用。 |

### Claude 专属功能

有几样东西只在 Claude rail 上能用——如果你需要它们，就选 Claude：

- **Agent Profile**——按 Agent 的模型路由。在 Codex 或 Gemini rail 上，运行始终走传统模式，所选的任何 Profile 都会被**忽略**。非 Claude 引擎下 Profile 选择器会被隐藏。
- **Freestyle**——那个自主的、绕过流水线的模式。`Freestyle` 分段及其 Haiku/Sonnet/Opus 模型选择器，只有当 rail 的引擎是 Claude 时才会出现。
- **Contract Layer 与 SMASH**——Claude 专属的 spec 优化功能（这些是 Add Spec 的选项，不是 rail 的选项，但同样的限制适用）。

如果一个项目混用了引擎，右侧栏只会显示**每一个**已安装提供方都支持的区块——所以在一个含有任何非 Claude 提供方的项目上，**Agents** 区会彻底消失，因为 Profile 是 Claude 特有的。

## 一套实用的工作流

多提供方项目在你想要**对比**或**调成本**时格外出彩：

- **对比实现。** 把同一个 spec 放到两条 rail 上，一条设为 Claude、一条设为 Codex，两条都启动（跨项目，或在同一个项目的队列里一前一后），然后用 Jobs 页面上的**对比**按钮来 diff 结果。
- **按 spec 调成本。** 高风险的 spec 用 Claude 配 `max` Profile 来跑；常规清理类的 spec 用 Gemini 跑以省钱。在 `/analytics` 里按引擎筛选，看清各自的明细。
- **设好合理的默认。** 把你最常用的引擎设为项目的主引擎，让 rail 默认用它，只在某个特定 spec 想换引擎时才按 rail 临时切换。

## 几点需要记住

- **提供方选择在项目创建后不可更改**（v1）。你在添加项目时选定要安装的提供方；之后没有 Settings 开关可以再增删。
- **成本始终会被追踪**，即便是不原生上报成本的引擎——应用会回退到价格表，让 Codex 和 Gemini 的运行也照样出现在[分析](../analytics/tracking-cost)里。
- 在多提供方项目上，**终端的"Open AI CLI"按钮**也会提供一个提供方选择器，方便你想手动驱动某个 CLI 时使用。

## 接下来去哪儿

- [使用 Codex](../integrations/using-codex)——安装与登录。
- [使用 Gemini](../integrations/using-gemini)——安装、`GEMINI_API_KEY`、遥测。
- [Rail 与任务](rails-and-jobs)——队列与启动流程。
- [追踪成本](../analytics/tracking-cost)——按引擎的成本明细。
