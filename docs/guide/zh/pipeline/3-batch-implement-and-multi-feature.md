# 批量实现与多功能

一次做一个 spec 当然没问题，但现实里的活儿常常是成串来的——一个功能加上它的测试、再加上它的迁移，或者一个你想一口气清空的待办列表。本页讲的是把多个 spec 放在一起跑：Batch 模式、依赖批次，以及流水线是如何防止并发工作互相打架的。

## 一次跑多个 spec

从一条 rail 跑一堆 spec，最简单的方式就是 **Batch** 模式：

1. **把所有你想跑的 spec 都拖**到同一条 rail 上。它们会在这条 rail 的 spec 列表里堆起来。
2. **把这条 rail 的模式切到 Batch**（rail 头部的分段控件）。
3. **按下 ▶ Play。**

这条 rail 会启动**一个** `/specrails:batch-implement` 任务，逐一处理每个分配进来的 spec。像监控其他任务一样在 Jobs 页面上盯着它就行——它是覆盖整组 spec 的单个任务，而不是每个 spec 一个任务。

这一点之所以重要，是因为有那条**每个项目一个任务的队列**规则。既然一个项目同一时间只跑一个 rail 任务，Batch 模式也就成了把一串 spec*串起来*的最干净方式，免得你去摆弄多条 rail、还要等每条逐个排空。

### Implement 还是 Batch——选哪个？

| | **Implement** | **Batch** |
|---|---|---|
| 命令 | `/specrails:implement` | `/specrails:batch-implement` |
| 每个任务的 spec | rail 上的全部，当作一个工作单元 | rail 上的全部，**依次**处理 |
| 最适合 | 一个紧密耦合的变更 | 几个想按顺序清掉的、彼此独立的功能 |
| 顺序 | 不适用 | 依赖感知的批次（见下文） |

如果这些 spec 真的属于同一个变更，用 **Implement**。如果它们是一串各自独立的功能，用 **Batch**，让它来排定顺序。

## 依赖批次

Batch 模式并不是简单地从上到下挨个跑 spec——它会计算出一个**依赖感知的执行顺序**，把 spec 分成一个个*批次（wave）*。编排器（`/specrails:batch-implement`）会算清楚哪些 spec 依赖哪些，然后排好日程，确保没有任何东西会跑在它所依赖的工作之前。

概念上是这样的：

```
Wave 1:  #2 (data model)        ← no dependencies, runs first
Wave 2:  #4 (API on the model)  ← waits for #2
         #5 (CLI on the model)  ← waits for #2
Wave 3:  #7 (docs across all)   ← waits for #4 and #5
```

在这个任务内部，每个批次的 spec 都会在下一个批次开始之前实现完。你不需要手动配置这些——编排器会从 spec 本身推导出批次。在[任务详情视图](the-job-detail-view)里看着它一步步展开：流式日志会讲述这一批正进行到哪个 spec，而工单头部会显示这个任务触及的每一个 spec。

## Worktree 隔离，以及工作是如何交付的

当多个 spec 在一次运行中被实现时，流水线会让每个工作单元保持隔离，这样并发或顺序的改动就不会把彼此的文件搞乱。每个 spec 的实现都跑在它自己那块干净的 **git worktree** 里——这是一个独立的检出，它共享你仓库的历史，但在 AI 干活期间绝不会碰你的工作树。

当运行结束时，**什么都不会被推送，也还没有任何 pull request 被创建**。工作安全地留在它们各自的隔离分支上，spec 进入一个新的 **On review（审查中）** 状态，然后 specrails **先来问你**：轨道上会出现一条常驻的决策栏，提供 **Create PR**——从你为项目指定的集成分支（在 **Settings → Integration branch** 里设置它；它默认取你仓库的默认分支）发起一个 draft pull request，把轨道上所有 spec 的工作合并在一起——以及 **Discard**。specrails **绝不合并，也绝不直接向你的集成分支提交**——PR 要不要存在由你决定，而合并这一步由人来掌控。这是一次安全的交接：只有你点头，specrails 才产出 pull request，你的工程师则像他们一贯做的那样，在 GitHub 里审查并合并它。

落到实处就是：

- 每个 spec 都得到一块干净的画布去实现，而不是半路接手上一个 spec 尚在进行中的编辑。
- 在运行进行期间，你的工作树绝不会被改动——在你点头之前，什么都不会落地。
- 运行完成后，spec 卡片会带上 **On review** 徽章，轨道向你提出那个问题：**Create PR** 打开合并后的 draft pull request，或 **Discard** 清理这些分支并把 spec 送回 backlog。如果这条轨道是从智能体聊天里启动的，同样的问题会以卡片的形式出现在那段对话里——在任何一处作答，两边都保持同步。
- 创建之后，**Open PR** 查看这个草稿，**发布** 把它开放给团队评审、交给你团队日常的 GitHub 审查流程，**Check merge** 则在你的团队完成合并后，把 spec 翻转为 Done。
- 如果在创建 PR 时这些隔离的分支没法干净地合并到一起，specrails 会安全地停下来，把这些分支留给人来处理——它绝不会把一次破碎的合并硬塞到你的基线上。你可以在同一条决策栏上重试或丢弃。

> 创建 PR 需要 GitHub CLI（`gh`）已完成认证，并配置好远端。若没有这些，specrails 依然会把工作保留在一个已提交的分支上，你可以自己从它发起 pull request——不会丢失任何东西，而且决策栏允许你重试。若要回退到旧行为（在本地整合而不是先询问），设置 `SPECRAILS_RAIL_DELIVER_PR=0`。

## 跨项目的多功能

如果你想要真正的并行——两个大功能同时在做——那就把它们**跨项目**拆开，而不是塞进同一个项目里的多条 rail。每个项目都有自己独立的队列，所以：

```
Project A   ▶ Rail running feature X   ┐
                                       ├─ run simultaneously
Project B   ▶ Rail running feature Y   ┘
```

没有全局并发上限，项目之间也没有争抢。两个都开着，各启动一条 rail，它们就会一起推进。唯一共享的节流是你的预算上限，它会在当天花费触到上限时，按项目或按应用级暂停队列。

## 大批量的小贴士

- **先把相关的 spec 凑到同一条 rail 上**，再切到 Batch——依赖批次只看得见这条 rail 上的内容。
- 在跑一个大批量之前**设一个每日预算**，这样一次意外昂贵的运行会自动暂停，而不是失控狂奔。在 [预算](../settings/customizing) 下配置它。
- 事后在 Jobs 页面**用对比按钮**把两次批量运行并排做 diff。
- **导出一份诊断**（如果当时开了遥测），就能拿到整批运行的精确 Profile + 插件快照。

## 接下来去哪儿

- [Rail 与任务](rails-and-jobs)——深入理解队列模型。
- [任务详情视图](the-job-detail-view)——实时观看一次批量运行。
- [为每条 rail 选择引擎](picking-an-engine-per-rail)——注意 Batch 可在任意提供方上运行；Ultra 仅限 Claude。
