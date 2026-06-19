# Profile 与均衡默认值

**Profile** 是一份为流水线运行而保存的「配方」。它在同一处回答了三个问题：

1. **哪些 Agent** 参与（基础三人组，外加任何专家型或自定义 Agent）。
2. 每个 Agent 用**哪个模型**运行。
3. 任务**如何路由**到这些 Agent。

你可以在任意项目的 **Agents** 区找到 Profile（右侧边栏 → **Agents** → **Profile** 标签页）。

## 均衡默认值

开箱即用时，项目会解析到一个合理的 **default** Profile。它包含基础三人组——`sr-architect`、`sr-developer`、`sr-reviewer`——并通过一条兜底规则把每个任务都路由给 developer。模型搭配在日常工作中保持均衡：在关键处用足够强的模型，而不会每一步都去动用最贵的那一个。

如果你的项目此前已经用老办法配置过 Agent 模型（写在 Agent 文件的 frontmatter 里），那么 **迁移** 按钮会读取这些配置，并构建出一个完整复刻当前行为的 `default` Profile——零损失，在你决定调校它之前什么都不会变。

重点是：**你不必先创建 Profile 才能使用 Specrails。** 默认值就能正常工作。Profile 是你想更进一步时的手段。

## 一次运行如何选定 Profile

当你启动一条 rail 时，Specrails 会按以下顺序挑选 Profile：

1. 你在 rail 头部做出的**显式选择**（见下文）。
2. 你的**个人开发者偏好**——你为此项目标记的、属于自己的默认 Profile（它只对你本地生效，不会被提交）。
3. 项目的 **`default`** Profile。

Profile 会在*启动时被快照固定*，因此一个批次里的每条 rail 都可以运行不同的 Profile，而日后改动某个 Profile 也绝不会重写已经启动的任务。

## 为每条 rail 选用 Profile

Profile 的选择就发生在你启动的地方——**rail 头部**，通过 Profile 选择器完成。

- 从下拉菜单中挑一个 Profile，**仅用于本次启动**。
- 使用持久化选项，把某个 Profile 设为这条 rail 此后固定的选择。

整个流程就这么简单：选一个 Profile、启动、搞定。同一批次中并发运行的 rail 各自带着自己的 Profile，所以一个快速修复和一个重量级功能可以并排运行、采用各不相同的配置。

## 当 Agents 区悄无声息时

Profile 是 Claude 的能力。在包含非 Claude 提供商（Codex 或 Gemini）的项目上，Agents 区会被隐藏，rail 会在没有 Profile 的情况下运行——这是预期行为，并非 bug。Profile 还要求项目中的 `specrails-core` 足够新；如果版本偏旧，你会看到一条黄色横幅。你创建的 Profile 仍会**保存**——只是在 core 更新之前不会影响流水线。按横幅中给出的命令更新，即可解锁它们。

## 接下来去哪儿

- [按 Agent 自定义模型](customizing-models-per-agent)——打造 `fast` 和 `max` Profile。
- [自定义 Agent 与目录](custom-agents-catalog)——查看并扩充你的团队。
