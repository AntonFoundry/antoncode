# @deepseek-ai/dsh-tool-anton-lifecycle

[English](README.md) | 中文

Anton 部署的模型可见生命周期控制插件。插件注册 `anton_status`、`anton_start`、`anton_stop` 和 `anton_restart`；每个工具都通过有界 HTTP 请求调用进程外的 Anton Bridge 监管器。

## 功能

Bridge 负责管理 Harness 子进程和本地 c0ntext 引擎。本包不会自行启动或监管这些服务。`anton_status` 报告健康状态，`anton_start` 启动运行时，`anton_stop` / `anton_restart` 请求监管器终止当前运行时进程。停止和重启成功执行时会结束当前模型回合；如果还能看到工具结果，通常表示请求被拒绝或 Bridge 变得不可达。

端点默认为 `http://127.0.0.1:3742`。`bridgeEndpointEnv` 默认为 `ANTON_BRIDGE_ENDPOINT`；非空环境变量会覆盖 `bridgeEndpoint`。如果端点不是 HTTP(S)，插件注册时会直接失败。每个工具都有独立超时，并传播调用方的取消信号。

## 配置

所有字段都是可选的，默认值适用于内置 Anton 部署：

```yaml
- id: tool-anton-lifecycle
  name: '@deepseek-ai/dsh-tool-anton-lifecycle'
  config:
    bridgeEndpoint: http://127.0.0.1:3742
    bridgeEndpointEnv: ANTON_BRIDGE_ENDPOINT
    statusToolEnabled: true
    startToolEnabled: true
    stopToolEnabled: true
    restartToolEnabled: true
```

使用相应的 `*ToolEnabled: false` 禁用单个工具。如果模型不应控制监管器，请禁用停止和重启工具。

## 导出形状

这是一个命名导出的函数插件，导出 `name`、`inject`、`Config` 和 `apply`，特意不提供默认导出。包还拥有用于包注册的 `./invariant` companion。

## 模型体验

### 工具 schema

#### 模型看到的内容

四个工具的 schema 和模型描述会生成到[工具目录](../../../docs/tool-catalog.md)。工具不接受参数，并返回 Bridge 提供的结构化 JSON。

#### Token 影响

每个可见工具都会为请求增加固定且较小的 schema 成本。禁用不需要的生命周期工具会移除相应的模型可见 schema。

#### KV Cache 影响

只要端点和启用策略不变，schema 前缀保持稳定。修改启用工具或描述会改变可见工具前缀，并可能降低缓存复用率。

### 工具调用历史和结果

#### 模型看到的内容

成功的状态/启动调用返回 Bridge 的 JSON。停止/重启可能在结果渲染前终止调用方；拒绝、超时或 Bridge 不可达时会返回明确诊断，而不是伪造成功。

#### Token 影响

历史长度随每次工具调用和紧凑 JSON 响应增长。停止/重启通常不会产生已完成结果，因为运行时进程会按请求退出。

#### KV Cache 影响

工具调用会追加在稳定请求前缀之后。重启会创建新的运行时，因此也会创建新的会话/缓存边界。

## 已知限制和延期工作

- 插件要求 Anton Bridge 正在运行且可访问；它不是通用的远程进程管理器。
- 内置 c0ntext 引擎由 Anton Bridge 启动时，仍要求兼容的 Docker/Compose 运行时。生命周期工具会报告依赖失败，但不会安装 Docker 或容器镜像。
- 停止和重启是会终止自身的操作。被终止的进程无法提供正常的操作后结果；应用恢复后请使用 `anton_status`。
