<!-- guide-revision: mission-first-v1 -->

# 选择提供方及其能力 {#provider-capabilities}

执行设置属于所选的提供方。模型名称看着眼熟，并不意味着每个提供方都支持同样的推理、结构化输出或审批控件。

## 先检查可用性

为提供方 CLI 完成身份验证，并在 Specrails 中确认它的状态。在该提供方的控件所提供的模型和推理强度中进行选择。即使 CLI 已安装，也可能因为会话、配额或远程服务不可用而失败。

Claude 和 Codex 使用不同的适配器。不受支持的组合应当在 loop 开始之前就失败；例如，不能假设一个要求无工具结构化响应的步骤在所有提供方上都能运行。

## 使用合适的控制级别

rail 的提供方/模型选择决定了它如何执行。图库中的 Freestyle loop 可在所有 CLI 提供方和本地引擎上运行；只有 Claude 额外提供任务内的交互式聊天。角色 Profile 和按 agent 的路由取决于提供方，以及 Desktop 在项目中安装的 Core 工作流；请检查实际生效的配置，而不要假设某个 Profile 会改变每一次调用。

对比运行时，请保持相同的 spec、仓库修订版本和验证标准。请把已上报的、估算的和不可用的成本分开看待。参见 [Profile](../agents/profiles-and-the-balanced-default) 和[用量](../insights/analytics-and-cost-tracking)。

对于从任务（mission）启动的运行，loop 步骤会继承任务的提供方、模型和推理强度，除非某个 agent 在 loop 编辑器中显式覆盖了它们。常规设置负责管理提供方连接；之前的“提供方默认值”区块和“角色”选择器已不再提供。
