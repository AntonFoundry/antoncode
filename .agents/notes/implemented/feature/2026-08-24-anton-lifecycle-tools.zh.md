# Agent Note：Anton 生命周期工具迁移到独立插件

Status: implemented

[English](2026-08-24-anton-lifecycle-tools.md) | 中文

## 问题

c0ntext memory 插件包含 `anton_restart` 工具和 Bridge 配置，尽管进程监管应由 Anton Bridge 负责。这使上下文记忆包耦合到单一产品启动器，也让生命周期行为分散在两个插件中。

## 决策

`@deepseek-ai/dsh-tool-anton-lifecycle` 现在拥有完整生命周期工具：`anton_status`、`anton_start`、`anton_stop` 和 `anton_restart`。它使用一个有界 HTTP helper 调用 Bridge 控制 API，在插件注册时验证端点，支持环境变量覆盖，并提供逐工具启用开关。c0ntext 插件恢复为只负责上下文镜像、驱逐、搜索和重新水合。

Bridge 仍是启动和停止进程的权威。停止和重启明确说明自身终止语义：正常情况下当前 Harness 进程会在渲染结果前退出。拒绝和 Bridge 不可达错误仍然以明确诊断呈现。

## 验证

本包包含 HTTP 路由、拒绝/错误行为、环境端点选择、配置开关、自身终止语义和包 invariant 的单元测试，以及真实 Loader 组合测试。本包已加入 host TypeScript 引用、base bundle manifest/patch 和生成的工具目录。

## 已知限制

内置 c0ntext 引擎作为 app resource 打包，但使用 Docker Compose；接收者仍需要兼容的 Docker 运行时，并在首次运行时具备拉取/构建镜像的网络访问。
