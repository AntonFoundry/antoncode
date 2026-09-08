# Agent Note：Agent 模式作为按工作区分组的实时会话面板
[English](2026-09-08-agent-mode-session-board.md) | 中文


状态：已实现

## 问题

Agent 模式此前把 `AgentGrid` 渲染成一行行卡片——只有会话标题和"updated"墙上时间。没有分组、没有运行/空闲状态、没有子代理、没有进度信号：繁忙会话与死会话无法区分，且注册表中的子代理谱系（父 id、origin）被平铺列表丢弃。面板也没有充分利用画框：本应平铺的空间里只有稀疏卡片。

## 决策

- `AgentGrid` 移到独立模块（`src/client/AgentGrid.tsx`），带纯函数 board 构建器 `buildAgentBoard`：每个工作区成为一个分区（按注册表顺序），每个注册会话成为一个窗格，子代理会话作为芯片行挂到最近的*已渲染*祖先——沿父链上溯直到命中某个窗格。工作区注册表未列出的子代理同样会挂载；父链离开所有已知工作区的子代理进入末尾的 `Unattached` 分区，保证运行中的窗格永远可见。
- 面板平铺整个 tree 区域：`auto-fit` 网格、等高窗格、1px 分隔线，取代稀疏卡片列表。
- 每个窗格的状态由摘要事实按固定优先级解析——`pending`（阻塞等待）> `running`（本会话或任一芯片）> `done`（离开期间完成）> `idle`——配以脉冲/常亮状态点、agent preset，以及运行中的每秒跳动的耗时钟（板级单一 interval，仅在有会话运行时启动）。
- 每个窗格一层芯片：board 只渲染窗格，所以挂载规则是"最近的已渲染祖先"，而非原始 parent id。

## 已考虑的替代方案

**深层嵌套子代理树。** 面板上否决：窗格平铺有限空间而深度无界；归属会话下的平芯片行在不塌陷布局的前提下让所有后代可见。更深的树属于 Phase 2 的聚焦窗格详情，不属于总览。

**每会话真实 pty（tmux 式进程）。** 否决：代理本就运行在 harness 内；窗格是保留摘要与事件流的视图，不是进程。pty 模式留作未来独立决策。

## 后果

- 窗格主体是状态加芯片，不是实时转写；每窗格的流式尾部是后续阶段，需要通过对象层订阅每会话事件，而非摘要镜像。
- 构建器在每次工作区变化时读取整个会话列表；会话数量小，但拥有数百会话的部署需要按工作区记忆化的索引。

## Phase 3 补充（真实 pty 终端窗格）

- 面板在会话窗格之外承载真实 node-pty 终端窗格：board 栏的 `+ terminal` 动作运行既有的 WM `term` 命令（spawn + 终端缓冲），面板把每个终端缓冲渲染为窗格——mode line 加 `terminal.view` 插槽占用者，归入 Terminals 分区头。缩放某窗格时隐藏终端窗格。
- 刻意保持薄：spawn/kill/resize 仍归 WM 缓冲生命周期所有（`C-x t` 生成、`C-x k` 关闭）；面板不引入第二套 pty 生命周期。窗格运行登录 shell——在其中启动 `anton` CLI 是用户操作，不是 spawn 参数。

## Phase 2.7 补充（活动尾部）

- 每个窗格主体渲染派生的活动尾部（最多四行：用户提问、`Ran <工具> <详情>`、助手文本、失败），取自会话的历史尾页——面板仅对活动窗格每 4 秒轮询一次，挂载时每个窗格读一次。
- 派生逻辑（`sessions/tail.ts`）在 runtime 中自包含、自带值类型；契约从那里导入。首次尝试两次破坏宿主聚合，值得记住：(1) 宿主车道通配 `packages/*/*/tests/**/*.ts` 且排除 `packages/client/*/src/**`——runtime 测试引用 client 源码时必须命名 `*.client.spec.ts`；(2) 每个二分中间态都必须可编译，因为 runtime 项目编译失败会让宿主程序回退到 client 源码并级联 TS6307。

## Phase 2.6 补充（Codex 式窗格外观）

- `ISessions.promptSession(id, text, mode)` 暴露按 id 的 `sessions.prompt` 调用；每个窗格带输入框（Enter 发送），模式跟随窗格实时状态——运行中为 `steer`，否则 `queue`——且不选中该会话。
- 窗格主体加入参考样式：底部条（agent preset · cwd）与运行中的 `Working · 计时` 标签；窗格本身改为 div（容纳输入框），保留点击打开（role=button），交互子元素阻止冒泡。

- `ISessions.interruptSession(id)` 暴露按 id 的原始 `sessions.cancel` 调用，无需选中该会话；面板的 Stop 控件使用它（嵌套在窗格内，`stopPropagation` 防止触发打开）。
- 缩放是渲染级的：缩放后的 board 只渲染聚焦窗格（占满整个网格）；窗格的缩放按钮与 Esc 退出缩放（tmux `z` 语义）。
- Board 查看偏好——窗格排序（`recent` / `status`）与最小窗格宽度——保存在所属工作区的 `dsh.layout.wm:<ws>` stash（`agentBoard` 键），每个工作区保留自己的排布；偏好栏通过 `onPrefsChange` 写入。
- 点击窗格仍是 attach 动作：把该会话打开为当前会话。
