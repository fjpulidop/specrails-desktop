# Rail 与任务

你已经在看板上准备好了一堆 spec，现在就到了把它们变成真实代码的环节。一条 **rail** 就是一条"通道"，负责把一个 spec 推过完整的流水线——Architect → Developer → Reviewer → Ship——并为你的项目运行真实的 AI Agent。本页会讲清楚如何启动一条 rail、并行执行是怎么回事，以及如何实时观看整个过程。

## 什么是 rail

可以把你的屏幕想象成左右两半：

```
SpecsBoard (左)             Rails (右)
─────────────────            ─────────────────
#1 Login flow      ─┐
#2 Webhook retry    │  拖拽到
#3 Cost limits      │ ────────────►   Rail 1   ▶ Play
#4 Audit log        │
                    └────────────►   Rail 2   ▶ Play
```

rail 是一条**执行通道**。你从 SpecsBoard 上拖一张 spec 卡片放到某条 rail 上，然后按下 **▶ Play**。对于 git 仓库，这条 rail 会在隔离的 git worktree 中启动流水线，让 AI 可以改文件、跑测试，而不会碰你当前活跃的工作树。如果项目还不是 git 仓库，Specrails 会明确降级到共享文件夹执行，并告诉你不会出现分支或 PR 卡片。

你可以同时拥有好几条 rail，把工作组织成一条条命名的通道（一条放你眼下专注的功能，另一条排在它后面候着）。rail 是**动态的**：Rails 头部的 **+ 添加** 按钮可以新建一条通道（每个项目最多 12 条），空闲且为空的通道可以删除。每条 rail 都由服务器托管，所以你的通道集合在刷新后依然保留，移动端 companion 和内置代理都能看到——当所有通道都在忙时，代理甚至能自己创建一条 rail。关于多 rail 和批量运行的更多内容，请看 [批量实现与多功能](batch-implement-and-multi-feature)。

## 在某个 spec 上启动一条 rail

1. **把一张 spec 卡片拖**到某条 rail 上。该 spec 的 ID 会出现在这条 rail 的 spec 列表里。（不想拖？用 spec 卡片上的 **放入 Rail** 弹窗——它会为每条 rail 显示一个状态圆点，避免你把活儿丢进一条正忙的通道。）
2. **在 rail 头部挑一个 Loop。** 一条 rail 运行的是一个 **Loop**——也就是它要做的活儿。默认是内置的 `Implement` loop；你也可以挑 `Batch`、`Freestyle`，或者你自己搭的某个自定义 loop。见 [Loop Builder](the-loop-builder)。
3. **按下 ▶ Play。**

就这么简单。rail 会在正确的执行上下文里启动一个 AI CLI 进程，开始跑流水线。

### rail 头部里有什么

| 控件 | 作用 |
|---------|--------------|
| **状态标签** | `idle`、`running` 或 `failed`。这里没有单独的"completed"——任务干净地跑完后，rail 会回到 `idle`。 |
| **spec 列表** | 分配给这条 rail 的 ID。可以再拖进来，也可以拖出去解除关联。 |
| **Loop 选择器** | 这条 rail 运行的 Loop——内置的（`Implement` / `Batch` / `Freestyle`）或某个自定义 loop。见下表。按 rail 单独记忆。 |
| **Profile 选择器** | 运行哪个 Agent Profile（仅限 Claude rail）。只有当项目至少有一个 Profile 时才会出现。 |
| **引擎选择器** | 这条 rail 用哪个已安装的提供方来跑——Claude、Codex 或 Gemini。仅当项目装有不止一个提供方时才显示。见 [为每条 rail 选择引擎](picking-an-engine-per-rail)。 |
| **▶ Play / ■ Stop** | 启动或取消。 |

### rail 运行的是什么：Loop

一条 rail 运行的是一个 **Loop**——干活的配方。有三个 loop 是**内置**的，覆盖了常见情况：

| 内置 loop | 命令 | 作用 |
|------|---------|--------------|
| **Implement** | `/specrails:implement` | 一个任务覆盖这条 rail 上的所有 spec。跑完整的 Architect → Developer → Reviewer → Ship 流水线。日常默认选项。 |
| **Batch** | `/specrails:batch-implement` | 一个任务，按依赖感知的批次（wave）依次处理 rail 上的各个 spec。最适合一组相关的 spec。 |
| **Freestyle** | Freestyle | Claude 自主实现每个 spec，**绕过**流水线。每个 spec 一个独立任务。仅限 Claude。 |

Freestyle 是个特例：它跳过 Agent 链条，把原始 spec 直接交给 Claude，让它用自己的原生工具去做。因为它比较"放飞"，所以按下 Play 会先弹出一个确认框，而且有一个按 rail 单独的模型选择器，让你在 Haiku / Sonnet / Opus 之间挑选。只有当 rail 的引擎是 Claude 时它才会出现。Freestyle 运行还是唯一会**一直开着等你**的任务：在任务详情的输入框里和它聊天，满意了就点击 **Finalize**（其他所有任务都会自己收尾）。

除了这些内置 loop，你还可以**搭建自己的 loop**——重复一个 verify → fix → verify 的循环直到目标达成、在 AI 步骤之间串联 shell 命令，等等。这些自定义 loop 会出现在同一个 Loop 选择器里。这就是下一个大点子：[Loop Builder](the-loop-builder)。

## 任务队列

每次你按下 Play，这次 rail 的运行就成了一个**任务**。最该记牢的一条规则是：

> **rail 是并行运行的。** 每次有 git 支撑的启动都会把工作隔离到每个 spec 独立的 git worktree 中，所以同一个项目里的多条 rail 可以同时运行、互不干扰。新的工作会落到一个 **On review** 决策卡片里，你可以创建 draft PR 或丢弃；如果某个 spec 已经有打开的 PR，后续修改会继续使用那条 PR 的分支，而不是重新从集成分支开始。

想让所有工作一起开跑？Rails 头部的 **全部启动** 按钮会一次性启动所有就绪的通道，只需一次确认，确认框会说明总成本（N 条 rail × AI 花费）。空的、已在运行的或等待 PR 决定的 rail 会被跳过，并在一个紧凑的汇总 toast 中报告。内置代理通过 `specrails_rails(launch_all)` 拥有同样的能力——而且当没有空闲通道时，它会自己创建一条新 rail。

没有 git 的项目不会有 worktree 隔离，也不会有 PR 续接。它们仍然可以运行，但 rail 会直接写入项目的共享文件夹，结果需要你在 spec 看板上手动接受或还原。

没有什么全局并发旋钮可调。唯一的自动节流是基于预算的：如果你设了每日预算（项目级或应用级），当当天的花费触到上限时，队列会自动暂停。

## 实时观看运行

在项目右侧栏的 **Jobs** 里能找到每一个任务——一个卡片列表，最新的在最前面。每张卡片显示一个状态徽章、Profile 徽章、优先级徽章、时长、成本，以及启动时用的命令。列表上方有：

- **状态筛选标签**——只显示某个状态的任务。
- **日期范围筛选**——收窄到某个时间窗口。
- **对比**——选两个任务并排查看。

点击任意一张卡片，就能打开**任务详情视图**，实时流式日志和实时指标都在那里——而且在 Claude 任务上，一个聊天输入框让你**向运行中的 Agent 提问，或在运行途中给它指方向**，什么都不用停。这就是下一页的内容：[任务详情视图](the-job-detail-view)。

## 取消一个任务

点击 rail 头部的 **■ Stop**。应用会向子进程发送 `SIGTERM`，等 **5 秒**让它干净退出，然后再 `SIGKILL` 掉它。不会留下半生不熟、还没启动完的进程。

## 如果一条 rail 启动不起来

如果你选了一个对应 CLI 还没装到机器上的引擎，启动会**快速失败**，而不是开一个坏掉的任务——什么都不会启动。装上缺失的提供方 CLI（[使用 Codex](../integrations/using-codex)、[使用 Gemini](../integrations/using-gemini)）再启动一次即可。缺 Claude 或 Codex 时会给出精确的 "*&lt;provider&gt; CLI not found*" 提示；缺 Gemini 目前会显示一个通用的启动错误，但结果是一样的。

## 全部停下

如果哪里看起来不对劲：

- **某一条 rail**——点击它头部的 **■ Stop**。
- **预算自动暂停**——设一个每日预算，当当天花费触到上限时队列会自我暂停。
- **全部**——退出桌面应用，或运行 `specrails-desktop stop`。

## 接下来去哪儿

- [Loop Builder](the-loop-builder)——rail 运行的是什么，以及如何搭建你自己的 loop。
- [任务详情视图](the-job-detail-view)——阶段、实时指标、工单卡片。
- [批量实现与多功能](batch-implement-and-multi-feature)——一次跑多个 spec。
- [为每条 rail 选择引擎](picking-an-engine-per-rail)——Claude、Codex 还是 Gemini。
