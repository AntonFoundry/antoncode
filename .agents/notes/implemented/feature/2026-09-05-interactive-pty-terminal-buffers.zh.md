# Agent Note: 交互式 PTY 终端缓冲区（`term` 域 + ui-terminal）

状态：已实现

## 问题

Harness GUI 没有终端界面：所有 shell 交互都走 agent 自己的工具通道（拉取式、净化过的环境变量、受控 `PS1`），用户无法在应用内运行自己的交互式登录 shell——别名、`~/.bash_profile`、`lsd` 图标、vim/htop 都不可用。窗口管理器也没有能承载终端的缓冲区类型，槽位系统中不存在 xterm 视图的席位。

## 决策

- **新增 `term` 线路域**（`packages/host/apiproxy`）：基于 node-pty（与 subprocess 接缝相同的 `node-pty@1.2.0-beta.15`）的 `spawn`/`read`/`input`/`resize`/`dispose`。`spawn` 以用户真实环境变量和 `TERM=xterm-256color` 运行 `/bin/bash -l`，因此 `~/.bash_profile`/`~/.bashrc` 会被加载，完整 ANSI/24 位颜色可用。输出传输采用**客户端持有游标的一元轮询**：宿主为每个会话保留 400 KB 尾部，`read({ since })` 返回游标之后的字节与下一个偏移——不为一级终端新增 mux/流帧。错误使用封闭的 `RpcErrorDetailsMap` 代码（`term-unavailable`、`term-no-session`、`term-spawn-failed` 等）。
- **新客户端插件 `packages/client/ui-terminal`**：承载 `@xterm/xterm` + `@xterm/addon-fit`，注册 WM 的 `terminal.view` 槽位（在 ui-layout 的 `SlotMap` 中声明，`owner: { sessionId?: string | undefined }`）。终端颜色在挂载时从已加载主题的别名令牌解析。
- **WM 集成**（ui-layout）：新增 `terminal` 缓冲区类型与 `C-x t` / `M-x term` 命令。缓冲区创建时**不带会话 id**；视图在面板网格稳定后自行 spawn PTY，使 shell 以真实面板尺寸诞生。
- **启动稳定性序列**（"chevron 花屏"报告背后的修复）：视图等待 `document.fonts.ready`，随后轮询 fit 直到连续两次结果一致且 ≥20 列，才 spawn。否则每次 fit 变化都会触发 `SIGWINCH`；bash 的 readline 无法在不覆写滚动回显的情况下重绘多行 `PS1`（用户看到的是滚动区顶部交错的 `>>>>` 字串）。维度变化守卫让后续布局稳定保持静默；只有真实的面板/窗口缩放才传播。
- **焦点跟随 WM**：终端窗格成为焦点叶时，LeafPane 聚焦 xterm 的 `.xterm-helper-textarea`，因此 `C-x o`/`C-x t` 无需点击即可把光标落进终端。上游 `xterm.css` 的关键规则（helper-textarea 停靠为 `opacity: 0`、`.xterm` 焦点/光标/选择、viewport 滚动）已移植进 `TerminalView.module.css`——本包从不加载上游 CSS。
- 退出提示只写一次（`[process exited — close the window or C-x t for a new shell]`）并停止轮询；关闭窗口即销毁 PTY。

## 已考虑的替代方案

**复用面向 agent 的 `ctx.terminals` 能力。** 否决：它按所有者（Agent）划界、面向行，且刻意净化环境变量/`PS1` 并带 OSC 133 就绪标记——与交互式登录 shell 恰好相反。

**为 `term` 生成 typert 远程命名空间。** 暂缓：对五个方法而言生成式贡献机制过重；插件通过 `ctx.get('connection')`（model-selection 服务已有的转型先例）访问类型化 `IApiClient`。当出现第二个消费者时再升级。

**用新的 mux 帧流式传输 PTY 输出。** 暂缓：基于宿主保留尾部的 60 ms 游标轮询对交互式使用毫无差别，并保持传输为一元；域后续可在不破坏契约的情况下升级为流。

**每次 read 都写退出提示。** 否决（曾导致缺陷）：宿主在进程死亡后持续返回 `exited: true`，提示会循环出现。提示只写一次并停止轮询。

## 后果

- `C-x t` 在分屏窗口中打开登录 shell；缓冲区与其他类型一样可跨窗口克隆；`C-x 0` 销毁 PTY。
- 颜色在视图挂载时跟随 `load-theme`；会话中途切换主题需要新开终端（已接受的首版限制）。
- 宿主为每个打开的终端保留一个 node-pty 进程；会话随应用进程死亡（无法跨重启重连——会话 id 不持久）。
- `@deepseek-ai/dsh-client-ui-terminal` 的 `dsh.client`/bundle 注册遵循标准三个界面（聚合引用、patch 行、web-app 依赖）。
