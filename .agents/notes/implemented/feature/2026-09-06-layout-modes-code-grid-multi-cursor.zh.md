# Agent Note：布局模式、code 模式终端网格与 multi-cursor 广播
[English](2026-09-06-layout-modes-code-grid-multi-cursor.md) | 中文


状态：已实现

## 问题

框架只有一种组合（侧栏 + 会话 + 详情），无法并排运行多个 agent——即每个 agent 一个终端的 BridgeMind/Codex 布局。面板可见性（context 切换）与品牌行的切换按钮硬编码在 WmFrame 内，插件无法触及；也没有办法向多个终端同时输入同一条命令。

## 决策

- **布局模式**（`agent` | `code` | `chat`）保存在布局 store 中，持久化于 `dsh.layout.mode`。模式是**树的视图**而非树变更：`agent` 原样渲染树，`chat` 全屏渲染第一个会话叶（树保持不变，回到 agent 模式即恢复所有窗口），`code` 将每个 `terminal` 缓冲区渲染为换行网格中的卡片（`auto-fit, minmax(480px, 1fr)`）并隐藏 context 切换。`M-x code-mode` / `chat-mode` / `agent-mode` 以及品牌行居中的分段控件切换模式。
- **Multi-cursor 广播**：ui-terminal 声明一个广播 store（广播开关 + 已挂载会话集合）。apply 创建唯一实例并以两种方式共享——inject 的 `hooks` 舱位（`hooks: { broadcast }` → 组件获得 `useBroadcast`）与 inject face（`broadcastActions` 写接口）。`M-x multi-cursor` 从 WM 抛出 `ui-terminal:toggle-broadcast` 事件；apply 监听并翻转同一实例。每个终端带有 ⧉ 悬浮开关；广播开启时，任一终端的按键写入所有已加入的会话。
- **顶栏槽位**：`shell.topbar.left` / `shell.topbar.right` 是品牌行子槽位，渲染于居中切换器两侧。布局向右槽位注册通知 + 账户占位按钮；ui-jobs/identity 应以真实占用者替换。

## 已考虑的替代方案

**按模式变更窗口树（关闭/打开叶）。** 否决：模式作为视图使树与所有持久化几何保持原样；侧栏/详情/分屏布局原样恢复。

**通过生成的远程命名空间或仅 M-x 接入 multi-cursor。** 否决：广播状态是纯客户端查看状态；在 register 声明的 store 是规范通道，WM→插件的切换沿用 c0ntext 已有的 DOM 事件接缝（`c0ntext:open-map`）。

**把广播实例放进 register 的 `store:` 工厂。** 实现后否决：框架会从工厂自行实例化，apply 创建的实例成为第二个实例——两个真相源。hooks 舱位承载 apply 创建的唯一实例。

## 后果

- code 模式下执行两次 `C-x t` 即得双窗口 agent 布局；广播（M-x multi-cursor 或 ⧉）将按键镜像到两者。
- 品牌行可被插件扩展：`shell.topbar.left/right` 的占用者出现在居中切换器两侧。侧栏与 context 切换仍是布局自有的品牌控件（它们切换布局自有状态）；将其迁回各自插件被延迟。
- 终端颜色与广播状态按视图挂载；广播在刷新后重置（不持久化——它是会话意图）。
