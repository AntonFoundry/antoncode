# Agent Note：子代理按次委派的推理力度

[English](2026-09-13-subagent-per-delegation-reasoning-effort.md) | 中文


状态：已实现

## 问题

蜂群的模型路由让父会话能精细控制每个子代理**用哪个模型**（[蜂群默认路由](../../../packages/subagent/tool-subagent/README.md#child-model-routing-swarm-defaults)），却无法控制它**思考多深**。`AgentOptions` 只有 `provider`、`model` 和 `maxTokens`；`reasoningEffort` 只存在于 `LlmCallConfig` 上，来源是会话已持久化的 `request/header` 或经 `agent/request` 注入。新建子代理于是永远运行在模型适配器默认力度上：父会话把大海捞针的检索委派给便宜模型、把设计决策委派给强模型时，两者都无法调力度，设置页的子代理卡片也没有可补偿的力度入口。与路由功能叠加后缺口更明显——一条 `provider/model` 路由可能把子代理落到默认力度与任务不匹配的模型上，且无从纠正。

## 决策

推理力度进入代理选项继承链，与 `maxTokens` 对称：

- `AgentOptions` 新增 `reasoningEffort?: string`（`dsh-agent`）。该边界保持无品牌字符串；循环只在调用配置边缘经 `ReasoningEffortId` 品牌化一次。
- 代理循环在没有可用持久化力度的会话上以 `this.options.reasoningEffort` 播种首个请求头（此后照旧经请求头持久化）。既有的恢复规则——仅当初始 provider/model 路由未变时保留已记录力度（[适配器拥有的推理力度能力](../architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md)）——保持优先；选项回退只在持久化请求头未命名力度时生效，这同时覆盖继承了无数力请求头的种子化子会话。
- `resolveChildAgentOptions` 在继承 `provider`/`model`/`maxTokens` 之外同时继承父会话力度；请求自带的 `agentOptions.reasoningEffort` 覆盖之。
- `tool-subagent` 暴露按次委派的 `reasoningEffort` 枚举参数，并单独或与 `model` 路由并列写入启动请求的代理选项。其插件配置 `agentOptions` 同样接受部署级 `reasoningEffort` 默认值。

校验保持在[适配器拥有的能力](../architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md)注记 placement：子代理选中的 provider 在 `prepareCall` 按模型校验 id，不可服务的力度使该子代理请求以 `UNSUPPORTED_REASONING_EFFORT` 失败——表现为委派出错的结果，绝不静默降级。工具 schema 枚举声明最宽的可移植集合（`off` 至 `max`）；适配器仍是权威。

## 测试

循环层：带 `AgentOptions.reasoningEffort` 的新建代理从选项播种首个请求头，后续轮次经请求头持久化该值；mock 模型只声明测试所指的力度，通过即证明是播种而非适配器默认。驱动层：带力度的父会话把力度传给子代理选项与请求，请求自带覆盖优先生效。工具层：schema 在启用与禁用后台两种实例上钉住新参数，捕获启动的断言证明调用的力度单独以及与路由并列时都抵达 provider。

## 已考虑的替代方案

**在 `subagent-child-model` 旁加设置节默认值。** 模型路由需要四层链，因为不同子代理合理地需要不同模型；单一全局力度默认没有按会话的消费者，只会重复插件 `agentOptions` 已拥有的配置面。按调用参数加配置默认已覆盖已表达的需求。

**把 `AgentOptions.reasoningEffort` 品牌化为 `ReasoningEffortId`。** 代理选项边界横跨插件配置（Schemastery 字符串）与工具 JSON；在其上品牌化会迫使每个调用方强转，而 `prepareCall` 处 provider 已拥有的校验不会增加分毫。

**改设置卡片而非工具。** 只做卡片无法让委派模型按任务匹配力度——最了解子任务难度的是写提示词的模型。

## 后果

子代理现可按次委派运行其模型声明的任意受支持力度。恢复的子代理保留已记录力度；会话被播种无数力请求头的子代理在首次请求时采纳其选项力度，与 `maxTokens` 对称。进程外 provider（`acp`、`codex`、`dsh-sdk`）在其 spawn spec 携带该字段前会忽略它——本次只接线进程内路径，它们的配置按路由响亮失败而非静默。
