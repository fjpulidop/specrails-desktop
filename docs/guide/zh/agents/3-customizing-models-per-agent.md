# 按 Agent 自定义模型

Profile 让你能做的最有用的一件事，就是**为每一步挑选合适的模型**。规划这一步也许值得动用你最强的模型；而一个常规的建造步骤，换上更快、更便宜的模型也许就足够称心。Profile 让你能把这种意图精确地表达出来。

这正是「共享 vs. 因项目而异」这一划分见效的地方：

- Agent 的*定义*在你的团队间保持共享。
- *每个 Agent 用哪个模型运行*则**因项目而异**，配置在 Profile 内，且只影响你自己的项目。

改一个模型，你就改变了这个项目的成本与行为——而不会动到任何其他人的配置，也不会动到 Agent 底层的指令。

## 更改某个 Agent 使用的模型

在 **Agents → Profile** 中选中一个 Profile，打开它的 Agent 链编辑器。链中的每个 Agent 都有一个模型字段。此外还有一个**编排器**模型，负责流水线最顶层的协调。

模型值是一些别名——对 Claude 而言就是 `opus`、`sonnet` 和 `haiku`（从最强 → 最快）。按 Agent 设置你想要的别名：

- 把某个 Agent 的模型**留空**，即回退到该 Agent 文件自带的默认值。
- 显式设置它，则仅在此 Profile 内覆盖。

保存之后，下一条用该 Profile 启动的 rail 就会使用新模型。已在运行的任务则保留它们的快照。

## 创建像 `fast` 和 `max` 这样的 Profile

很自然的做法，是准备几个命名好的 Profile，视任务不同随手取用：

**一个 `fast` Profile**——用于小型、低风险的改动，你追求的是速度和更小的账单：

- Architect：一个中档或快速的模型——方案本身很简单。
- Developer：一个快速的模型——改动是机械性的。
- Reviewer：保持稳妥，但这里你也可以适当精简。

**一个 `max` Profile**——用于棘手、高风险的功能，你希望每一步都尽可能锋利：

- Architect、developer、reviewer：全线都用你最强的模型。

### 两种构建方式

1. **复制再微调** *（推荐）。* 选中你的 `default` Profile，**复制** 一份，给副本起一个 kebab-case 名称，比如 `fast` 或 `max`，再逐个调整每个 Agent 的模型。你继承了一套已知可靠的链和路由，只改动你确实想改的部分。
2. **从空白开始。** 创建一个 **空白 Profile** 并亲手组装这条链。你仍然必须包含基础三人组（`sr-architect`、`sr-developer`、`sr-reviewer`）——流水线依赖这三个 Agent——以及恰好一条终止性的兜底路由规则，且它必须排在最后。

Profile 名称使用小写 kebab-case（例如 `fast`、`max`、`cheap-and-cheerful`）。

## 把任务路由到特定 Agent

Profile 的**路由规则**决定由哪个 Agent 处理带标签的任务。每条规则列出若干任务标签和一个目标 Agent；标签最先匹配上的规则胜出，末尾的一条 `default: true` 规则则兜住其余所有任务。只有真正在 Profile 链中的 Agent 才能作为路由目标——编辑器会强制这一点。

日常使用中你不会去碰路由：兜底规则把工作交给 developer，这就是对的。当你想让带 `migration` 标签的工作转交给某个专家型 Agent 时，再去动用标签规则。

## 启动时挑选 Profile

所有这些都在启动时汇聚到一处：在 rail 头部，为每条 rail 选择 `fast`、`max` 或 `default`。一个批次可以混搭——一个小修复跑 `fast`、一个大功能跑 `max`，两者同时运行。选择流程参见 [Profile 与均衡默认值](profiles-and-the-balanced-default)。

## 关于安全的一点说明

删除一个 Profile 对进行中的工作是安全的：已用它启动的任务保留各自的快照，而未来的启动只会沿着解析顺序回退。尽管放手去试。

## 接下来去哪儿

- [自定义 Agent 与目录](custom-agents-catalog)——添加可放进你的链里的 Agent。
