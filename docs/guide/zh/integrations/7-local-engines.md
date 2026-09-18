# 本地 AI 引擎

让 Specrails 运行在你自己托管的模型上——Ollama、llama.cpp、LM Studio、vLLM，或任何支持 OpenAI chat-completions API 的服务器。连接后，本地端点就是一个普通引擎：会出现在 rail 标题栏、添加 spec（Quick 与 Explore）、侧栏聊天和 agent 任务中。

## 连接端点

1. 打开 **设置 ▸ Specrails Agents ▸ 提供商连接**，选择 **添加本地引擎**。
2. 填写 id、基础 URL（例如 `http://127.0.0.1:11434/v1`），如果服务器需要密钥，填写**保存密钥的环境变量名**。密钥永远不会被保存——Specrails 在每次启动运行时从应用环境读取它。
3. 点击 **测试连接**。服务器响应后指示灯变绿，并列出其提供的模型。选择一个默认模型。
4. **保存**。引擎立即可用，无需重启。

> 从 Finder、Dock 或开始菜单启动应用不会继承 shell 的 export。若卡片提示该变量*未在应用进程中设置*，请在系统级别设置它，或从已设置该变量的终端启动应用。无需密钥的服务器不需要任何配置。

每个连接还有一个 **Agent 循环** 设置。**紧凑**（默认）通过简短的结构化步骤驱动小模型，正是它让 7–14B 模型能跑通 implement；**自由** 是面向强模型（约 30B 以上）的经典单一 agent 循环。请把 **上下文窗口** 设为服务器的真实大小，以便 Specrails 在服务器拒绝请求前进行压缩。

## 你将获得

- Rails（implement、batch、freestyle、自定义 loop）、Explore 与 Quick spec、聊天和任务都在本地模型上运行。
- 任务保留 Specrails 工具和你的外部 MCP 服务器。
- 会话可跨轮次恢复；交互式 job 可用。
- 成本诚实：记录 token，除非你填写费率，否则成本显示为*未知*（填写后标记为*估算*）。

本地引擎不支持：agent 配置文件与自定义角色、SMASH / Contract Layer 增强、Project Builder 生成、附件与流水线遥测。

> 任务需要服务器提供**较大的上下文窗口**（64k token 以上）：operator 提示词加上 Specrails 工具 schema 体积很大。聊天和 Explore 在 32k 下即可。若某轮以 *exceeds the available context size* 失败，请增大窗口（Ollama `OLLAMA_CONTEXT_LENGTH`、llama.cpp `-c`、LM Studio *Context Length*）。

## 选择模型

质量取决于模型而非 Specrails。运行 rails 请使用 30B 参数以上、针对工具调用调优的代码模型；较小的 instruct 模型足以应对聊天、Explore 和 Quick spec。将完整的 implement rail 交给新模型之前，先试试 **Freestyle** 或一次 Explore 会话。

## 关闭

在应用环境中设置 `SPECRAILS_LOCAL_ENGINES=false` 即可在所有位置隐藏本地引擎。已保存的连接会保留，并仍可作为程序化运行时的按角色提供商使用。
