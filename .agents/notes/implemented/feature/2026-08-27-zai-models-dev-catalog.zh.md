# Agent Note：ZAI 模型目录在启动时从 models.dev 刷新

Status: implemented

[English](2026-08-27-zai-models-dev-catalog.md) | 中文

## 问题

`zai` 路由的选择器列表来自已安装的 pi-ai 目录，而它只有在升级
`@earendil-works/pi-ai` 时才会变化。提供方最新的模型 id——促成本记录的案例：
`glm-5.3-flash` 在 Z.AI coding 网关上发布后，要等一次本仓库无法控制的依赖发版才能
出现——在目录更新前一直不可见。现有的 `liveModelDiscovery` 开关会询问网关自身的
列表，但它是可选开启的，而且在凭据存入之前根本无法使用。

## 决策

插件启动时默认从 models.dev（`https://models.dev/api.json` 的 `zai-coding-plan`
条目）填充 `zai` 路由——与 OpenCode 选择器读取的同一目录源——通过
`fetchModelsDevLiveModels`（`src/models-dev.ts`）。来源优先级为：显式 `models:`
配置（完全跳过刷新）、`liveModelDiscovery: true` 询问端点自身列表、默认的
models.dev 读取、models.dev 拉取失败时回退到端点列表，最后是带警告的内置目录。
设置变更会重新触发刷新；尚未成功时，模型列表读取会惰性重试
（`adapter.listModels` 会等待它）。

目录载荷可以为已安装目录从未见过的 id 携带 `reasoningEfforts`；live-model 转换会
转发它们，使新模型依然能派发思考（`ZAI_REASONING_EFFORTS`，即内置 glm-5.2 条目声
明的拼写）。已安装目录同时收录的 id 保留其已安装配置；载荷容量覆盖已安装值。

## 已否决的替代方案

- **升级 pi-ai** 让新鲜度继续受制于另一个项目的发版节奏，而且仍无法覆盖
  `zhipuai-coding-plan` 这类计划专属条目。
- **让 `llm-models-dev` 服务 zai** 会割裂路由归属：该插件声明自己的路由和免费层判
  定，而 zai 路由属于 pi-ai 的 provider 物化。
- **默认使用网关列表** 在选择器首次渲染之前就需要凭据，并且每次启动都花费一次鉴权
  请求去取公开目录已经发布的数据。

## 已知限制

当端点的 `/models` 列表与 models.dev 不一致时，只有显式设置 `liveModelDiscovery`
才会以端点为准。两个来源与内置目录都没有的模型仍需手工声明配置。
