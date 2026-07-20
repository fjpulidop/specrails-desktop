# 自定义 Agent 与目录

Profile 决定的是*哪些 Agent 运行、用什么模型*。但 Agent 本身又是从哪儿来的呢？答案就是 **Agent 目录**。

在任意项目中打开 **Agents → 目录**。它是一个只读视图，列出该项目可用的每一个 Agent，分为两组：

- **上游 Agent**——随 `specrails-core` 一起发布的 Agent：基础三人组（`sr-architect`、`sr-developer`、`sr-reviewer`）以及像 `sr-merge-resolver` 这样的任何专家型 Agent。
- **自定义 Agent**——你自己添加的 Agent，命名为 `custom-*`。

每个目录条目都会展示该 Agent 的用途和它的默认模型，这样在把 Agent 接入某条 Profile 链之前，你就能看清整支阵容。

## 添加一个自定义 Agent

Role 是 provider-native asset：Claude 使用
`.claude/agents/custom-<name>.md`；Kimi 使用
`.kimi-code/skills/custom-<name>/SKILL.md`。

Asset 存在后会出现在对应 provider 的目录中，其 id 只能加入同 provider 的 Profile。`custom-docs` 在 Claude 中对应 `.claude/agents/custom-docs.md`，在 Kimi 中对应 `.kimi-code/skills/custom-docs/SKILL.md`；二者互不混用。

由于它们就住在你的仓库里，自定义 Agent 是**可提交的团队资产**：提交这个文件，你的整个团队就都拥有了这个 Agent。这呼应了贯穿整个 Agents 区的核心观念——

> **Agent 定义是共享的（它们住在仓库里，随 `git` 一起流转）。模型配置则因项目而异（它住在 Profile 里）。**

Core 保护两种格式。Kimi 支持手动 create/edit/run；Generate、Test 和
AI Refine 会在 spawn 前拒绝。

## 让自定义 Agent 上岗

典型流程如下：

1. 创建 native Claude asset 或 Kimi Skill，并使用有效指令/model。
2. 确认它出现在 **Agents → 目录** 的「自定义」分组下。
3. 在 **Agents → Profile** 中，把这个 Agent 加入某条 Profile 链（也可在该 Profile 内覆盖它的模型）。
4. 添加一条路由规则，让带有合适标签的任务到达它——或者依赖链的顺序。
5. 在 rail 头部用该 Profile 启动一条 rail。

## 观察 Profile 的表现

Agents 区还有一个 **用量** 标签页——按 Profile 拆分，展示在所选时间窗口内每个 Profile 各启动了多少个任务。这是个快速的途径，既能确认你的 `fast`/`max` 划分是否真按你设想的方式在被使用，也能看出你的团队更偏爱哪个 Profile。

## 整个章节回顾

- **Agent** 是专职的团队成员——共享的三人组，外加专家型 Agent 和你的自定义 Agent。（[认识这些 Agent](meet-the-agents)）
- **Profile** 打包了哪些 Agent 运行、用哪些模型、任务如何路由——在启动时按 rail 选用。default Profile 是日常里那个均衡之选。（[Profile 与均衡默认值](profiles-and-the-balanced-default)）
- **模型** 在 Profile 内按 Agent、按项目调校——打造 `fast` 和 `max` 以匹配不同任务。（[按 Agent 自定义模型](customizing-models-per-agent)）
- **目录** 展示每一个 Agent，而 `custom-*` 命名空间让你得以壮大团队——定义共享，配置因项目而异。
