# 为每条 rail 选择引擎

Specrails desktop 把 **Claude Code**、**Codex CLI**、**Gemini CLI** 和
**Kimi Code** 都当作一等引擎。可安装任何 compatible 组合。

## 选择器何时出现

**引擎选择器**就在 rail 头部，紧挨着模式控件。只有当项目装了**不止一个**提供方时它才会出现。

> **单提供方项目的行为逐字节一致。** 如果一个项目只装了一个引擎，就不会显示选择器，提供方选择相关的一切也都不会变——它就直接在那个引擎上跑。这个选择器纯粹是给多提供方项目用的。

当它确实出现时，你的选择是**按 rail、按每次启动**生效的——不同的 rail 可以跑不同的引擎，而你的选择会按项目记住（默认为项目的主引擎）。

## 如何选择一个引擎

1. 确认这条 rail 的引擎选择器正在显示（项目有 2 个及以上提供方）。
2. 选择 **Claude**、**Codex**、**Gemini** 或 **Kimi**。
3. 用 **▶ Play** 启动这条 rail。

被选中的引擎会跑这条 rail 流水线的每一个阶段。如果所选引擎对应的 CLI 没装，启动会快速失败——什么都不会启动。装上缺失的 CLI 再试一次即可。

## 每个引擎擅长什么

三者都能跑标准的 **Implement** 和 **Batch** 流水线。下面是一份实用的选择指南：

| 引擎 | 在什么情况下选它…… | 说明 |
|--------|--------------------|-------|
| **Claude** | 需要原生成本、持久交互或严格 tool policy。 | Profile、Freestyle 和 structured transform。 |
| **Codex** | 你更喜欢 OpenAI Codex CLI，或想跨提供方对比实现。 | `codex` ≥ 0.128.0。无原生成本上报——应用会用自己的价格表来补上成本。Profile 不适用。 |
| **Gemini** | 你想用 Google 的 Gemini CLI、原生遥测，或为常规 spec 跑得更省钱。 | `gemini` ≥ 0.11.0（需设置 `GEMINI_API_KEY`）。原生 OTLP 遥测。Profile 不适用。 |
| **Kimi** | 用 agentic Kimi 跑 Implement、Batch、Freestyle 或无 Decider 的 loop。 | 外部 `kimi` ≥ 0.27.0；profile/role，effort 仅 K3；token/cost unavailable。 |

### Capability 差异

Claude/Kimi 支持 Profile 和 Freestyle；Codex/Gemini 使用 legacy。Kimi
拒绝 Loop Decider 和 [Kimi 指南](../../../kimi.md) 中的 pure-output
transform。Claude/Kimi Profile 彼此隔离。

## 一套实用的工作流

多提供方项目在你想要**对比**或**调成本**时格外出彩：

- **对比实现。** 把同一个 spec 放到两条 rail 上，一条设为 Claude、一条设为 Codex，两条都启动（跨项目，或在同一个项目的队列里一前一后），然后用 Jobs 页面上的**对比**按钮来 diff 结果。
- **按 spec 调成本。** 高风险的 spec 用 Claude 配 `max` Profile 来跑；常规清理类的 spec 用 Gemini 跑以省钱。在 `/analytics` 里按引擎筛选，看清各自的明细。
- **设好合理的默认。** 把你最常用的引擎设为项目的主引擎，让 rail 默认用它，只在某个特定 spec 想换引擎时才按 rail 临时切换。

## 几点需要记住

- **提供方选择在项目创建后不可更改**（v1）。你在添加项目时选定要安装的提供方；之后没有 Settings 开关可以再增删。
- **available metrics 会记录。** Kimi 不提供 authoritative token/USD
  cost，字段保持为空。
- 在多提供方项目上，**终端的"Open AI CLI"按钮**也会提供一个提供方选择器，方便你想手动驱动某个 CLI 时使用。

## 接下来去哪儿

- [使用 Codex](../integrations/using-codex)——安装与登录。
- [使用 Gemini](../integrations/using-gemini)——安装、`GEMINI_API_KEY`、遥测。
- [使用 Kimi](../../../kimi.md)——安装与完整矩阵。
- [Rail 与任务](rails-and-jobs)——队列与启动流程。
- [追踪成本](../analytics/tracking-cost)——按引擎的成本明细。
