<!-- guide-revision: mission-first-v1 -->

# 连接 AI 提供方 {#ai-providers}

Specrails 负责协调你已完成身份验证的 Claude 或 Codex CLI。提供方的安装、账户访问和模型计费都与本应用相互独立。

## 连接并验证

按照官方说明安装你需要的 CLI，并用你打算使用的账户登录。在 Specrails 中检查它是否可用，然后为任务或 rail 选择受支持的模型和设置。

探测检查成功并不能保证下一次调用时配额或网络可用。在重试实现之前，请先解决身份验证和兼容性错误。

## 了解边界

应用会把项目记录保存在本地，而模型请求和已配置的集成可能会把上下文发送到你的机器之外。请据此决定要提供哪些引用和附件。

各提供方的能力不尽相同：推理控制、结构化响应、子代理以及运行中回合的引导，在不同提供方之间并不能互换。参见[提供方执行设置](../pipeline/picking-an-engine-per-rail)和[引导](../pipeline/the-job-detail-view)。

Sonnet 选项运行的是 Claude Sonnet 5.5（`claude-sonnet-5-5`）。[Anthropic](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)。
