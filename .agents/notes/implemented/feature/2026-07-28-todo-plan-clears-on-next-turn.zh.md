# Agent Note: 下一轮次开始时清空 todo 计划条（已反转——计划现跨轮保留）

Status: implemented

[English](2026-07-28-todo-plan-clears-on-next-turn.md) | 中文

## 问题

`todo_write` 在会话日志中存储完整列表快照，交互式宿主把最新列表渲染为计划条（web TodoPanel 经 `todos` 投影，TUI Plan 面板）。一个轮次结束后，该条仍留在下一用户轮次的屏幕上——上一任务已完成或已放弃的清单。读者把计划条理解为「本轮次正在做什么」，因此跨轮次的陈旧列表是错误的产品生命周期。[web todo 展示](2026-07-23-web-todo-display.md)与 [`todo_write` 工具](2026-06-29-todo-write-tool.md) Agent Note 仍拥有事件溯源与两个渲染面；它们把常驻计划描述为持续整段会话直至下一次写入。

## 决策

**已反转（2026-09-08）：常驻计划跨轮保留。** `todos` 投影现为日志中最近一条 `todo/write`；没有任何事件将其清除。下方的清除规则曾先行发布，因产品原因被回退。

反转理由：清除在用户发送任何消息的瞬间触发——包括"继续第二阶段"——计划恰在后续工作开始时消失，用户会把空面板读成待办系统丢了计划。这棵树是用户跨轮监控的常驻计划，不是单轮草稿；模型会在每个新请求时重写整棵树（工具描述已如此说明，并要求把后续阶段保持为 `pending` 而非全部上报完成），陈旧由下一次写入纠正，而非清除。

原始决策（已不再发布）：常驻计划是其后没有更晚 `turn/start` 的最近一次 `todo/write`。`turn/end` 保留列表可见，以便用户阅读回答时仍能看到刚完成的清单；下一次 `turn/start` 将其清空，直至模型再次写入。

### 宿主投影（web）

`dsh-tool-todo` 的 `todos` 投影单元折叠反转后的规则：`apply` 从每个 `todo/write` 取完整列表，没有任何事件将其清除（`stateVersion` 4；原始清除折叠以 `stateVersion` 2 发布）。载体（`dsh-host-apiproxy`）在历史记录尾部的 `projections` 块中提供该值，并以 `session/projection` 帧推送；web dock 经 `useProjection('todos')` 读取。无密钥 fixture（测试前置数据）镜像同一折叠，供组装后的快照使用。

### TUI 实时路径

原 TUI 的 `renderEvent` 分支曾在 `turn/start` 清空本地计划面板、在 `todo/write` 替换之，其重建路径在回放前重置面板，使冷恢复收敛到同一规则；该包其后已被移除（[移除 TUI 包](../simplification/2026-08-04-remove-tui-package.md)）。

## 考虑过的替代方案

- **在 `turn/end` 清空**——用户仍在阅读刚完成的回答时就隐藏清单；此时计划条的职责是已完成计划，而非空 dock。
- **仅在全部项为 `completed` 时清空**——会让放弃或部分完成的计划跨轮次残留；计划条仍会显示另一任务的工作。
- **在轮次开始时追加空的 `todo/write`**——为 UI 生命周期规则改写日志，并捏造模型从未写出的写入。

## 后果

宿主投影与 TUI 面板共用同一生命周期规则；重新打开会话仅在其后没有更晚轮次开始时恢复计划。部分取代 [web todo 展示](2026-07-23-web-todo-display.md)与 [`todo_write` 工具](2026-06-29-todo-write-tool.md)中「会话级常驻计划」的表述：事件溯源、last-write-wins 替换与两个渲染面仍归那些 Agent Note；本 Agent Note 拥有轮次边界清空。覆盖：tool-todo 投影对 turn/start 清空与 turn/end 保留的规格测试、供组装 web 快照的 fixture 推送帧清空，以及启动下一轮次并固定计划条已消失这一结果的 TUI 快照。
