# @deepseek-ai/dsh-client-ui-terminal

[English](README.md) | 中文

终端 shell 插件：一个 [xterm.js](https://xtermjs.org/) 视图，占据窗口管理器的 `terminal.view` 槽位——每个终端缓冲区一个交互式 PTY 会话，以 `C-x t` / `M-x term` 打开。决策记录：[交互式 PTY 终端缓冲区 Agent Note](../../../.agents/notes/implemented/feature/2026-09-05-interactive-pty-terminal-buffers.zh.md)。

视图为每个缓冲区拥有一个 xterm 生命周期：等待 web 字体与稳定的面板网格（连续两次 fit 一致且 ≥20 列），以该网格通过 `term` RPC 域 spawn shell，随后以 60 ms 节奏、按客户端持有游标轮询宿主保留的输出尾部。按键直通 `term.input`；容器缩放只在网格真正变化时传播，因为每次 `SIGWINCH` 都会让 bash 的 readline 重绘其（多行）提示符并弄花回显区。关闭缓冲区即销毁会话；shell 退出后轮询停止，视图写一条退出提示。

颜色在视图挂载时从已加载主题的别名令牌解析——打开终端前执行 `load-theme` 会为其着色。上游 `xterm.css` 的关键规则已移植进 `TerminalView.module.css`；键盘捕获 textarea 功能上必需、视觉上隐藏。

`/client` 导出仅为插件体（`apply`/`inject`）与组件 prop 契约类型；视图组件保留在包内部，藏在槽位注册之后。插件通过 `ctx.get('connection')`（model-selection 服务的既有模式）读取类型化 `IApiClient`——暂无生成的远程命名空间。

## Model Experience

无：终端是用户↔shell 的直接界面；此处没有任何内容进入模型请求。shell 是用户的登录 bash（`bash -l`、真实环境变量、加载 `~/.bash_profile`/`~/.bashrc`）——刻意**不是** agent 自己的终端工具所用的净化、OSC-133 标记 shell。

#### KV Cache 效果

无；本包既不组装也不发送 provider 请求。

## 已知限制与延迟工作

- **应用重启后无法重连**——PTY 会话 id 仅存于宿主内存；重启会让缓冲区落在死会话上（视图在下一次轮询时写出退出提示）。
- **会话中途切换主题需要新开终端**——颜色在挂载时采样一次；xterm 的 theme 尚未在 `theme/change` 时重新应用。
- **bash 多行提示符在窗口缩放时重绘会花屏**——readline + 3 行 `PS1` 的固有行为（kitty 相同）；客户端通过绝不发送无真实维度变化的 `SIGWINCH` 来约束它。
- **输出传输是 60 ms 游标轮询而非流**——交互式使用无差别；若延迟成为问题，后续可在不破坏契约的前提下升级为 mux 流。
