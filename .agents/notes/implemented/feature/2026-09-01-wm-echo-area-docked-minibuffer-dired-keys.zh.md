# Agent Note: 回显区、停靠 minibuffer 与键盘 dired
[English](2026-09-01-wm-echo-area-docked-minibuffer-dired-keys.md) | 中文


Status: implemented

[English](2026-09-01-wm-echo-area-docked-minibuffer-dired-keys.md) | 中文

## Problem

窗口管理器没有常驻状态面：和弦前缀与命令反馈要么不可见、要么漂浮在弹层里，而 minibuffer 覆盖在树上方，不像 Emacs 的回显区那样位于框架底边。dired 文件缓冲区只有点击导航——当其窗口通过和弦获得 WM 焦点时，列表容器从未持有 DOM 焦点，按键必须先点击一次才生效；C-p/C-n 完全无效；选中行还可能滚出视野。而在宿主未装载 browse 能力的部署里，`C-x d` 整体失效：当组合的目录选择器提供 `native`（OS 对话框）面时，`host.listDirectory` 直接拒绝。

## Decision

- `StatusLine.tsx` 是框架在流内排布的常驻最后一行（位于树下方）：按优先级显示和弦前缀回显（`C-x-`）、瞬态消息（经 WmFrame 的 `notify`，4 秒后自动消退）或聚焦缓冲区这一静止面；右侧承载缓冲区名与窗口数。命令反馈落在其中（`Split below/right`、`Closed window`、`The last window stands`、`Killed <buffer>`、`Wrote *scratch*`、`Layout reset`、`Undo`/`Redo`、`Layout dumped to *scratch*`、`Quit`）。
- minibuffer 停靠在回显区正上方的框架流内：打开提示会让框架尾部生长（树收缩），而不是漂浮覆盖；回显条在其下保持可见。
- which-key 弹层只保留补全列表——和弦回显归回显区。
- `FilesBuffer` 增加 `active` prop（所在窗格的 WM 焦点）：当其窗口成为聚焦叶子时，列表容器取得 DOM 焦点，按键无需先点击。`C-p`/`C-n` 与 `↑`/`↓`/`n`/`p` 一起驱动选择，选中行随动滚动进视野（`scrollIntoView`，nearest）。
- 应用 profile overlay 将目录选择器钉定为 `@deepseek-ai/dsh-host-directory-picker-browse`（组合层文档记载的 overlay 钉定方式），因为 dired 的列表能力经由 `host.listDirectory`，而 native OS 对话框面会拒绝。代价：工作区目录选择改用网页内列表，而非 OS 对话框。
- 列表 wire 扩宽：`DirectoryEntry` 携带 `isDirectory`/`size`/`mtimeMs`/`mode`，`list` 接受 `{ includeFiles }`——目录选择器保持仅目录的默认，dired 则始终请求完整层级并渲染类型/权限/大小/日期列（`dired.ts` 负责格式化；对文件按 Enter 交给宿主 `openPath`）。`C-x C-f` 以聚焦会话的 cwd（工作区目录）为起点，`C-x d` 以主目录为起点。

## Alternatives considered

**保留漂浮 minibuffer，在其上方另加一条状态行。** 拒绝：两个堆叠的底部表面重新制造了 Emacs 已合并的 echo/minibuffer 分裂；回显区与 minibuffer 本就是一个会扩展的表面。

**让 dired 按键经全局和弦监听器加模式标志路由。** 拒绝：全局监听器是和弦解析器的家，不是逐缓冲区键表；让列表容器持有 DOM 焦点使按键归属保持局部，文本字段守卫也不受影响。

**让 native 选择器面提供 `listDirectory`。** 拒绝：native 对话框无法枚举列表；browse 能力在设计上就是列表接缝。

## Consequences

- 框架永远以一行回显区收尾；提示从它向上扩展，同 Emacs。
- 经和弦驱动的 dired 窗口（C-x d、C-x b、C-x o）自获得焦点起即是键盘完备的：方向键、C-p/C-n、Enter、`^`、`g`、`d`、`s`、`q`、Alt+方向键。
- 依赖宿主组合钉定 browse 选择器；仅提供 `native` 的组合中 dired 列表依然失效（RPC 按设计大声拒绝）。
