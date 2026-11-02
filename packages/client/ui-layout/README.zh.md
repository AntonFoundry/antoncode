---
description: "Web GUI 的外壳布局：把侧边栏、会话、详情与各类缓冲区平铺为窗格的窗口管理器框架、面板服务与主题呈现；供窗口外壳的使用者与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-layout

[English](README.md) | 中文

## 概述

本包提供 Web GUI 的窗口管理器框架（WmFrame）：它把侧边栏、会话、右侧面板以及文件、终端、草稿与设置缓冲区平铺为同一棵窗口树中的窗格，并提供 `ctx.layout` 面板控制。它保留上游的 slot 词汇（`sidebar`、`main`、`rightbar`、`shell.bottom`、`shell.overlay`、`shell.leading`），因此上游占用方无需改动即可注册并在窗格中渲染。主题呈现器负责配色、别名 token、字号、字体列表、当前主题 id 与 document 元数据。窗口树持久化在 `localStorage`（`dsh.layout.wm`）。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

桌面 Mod+B 通过与控件共用的布局操作切换左侧栏。模态弹窗打开时此快捷键不可用；终端输入优先。

root slot 渲染一棵窗口树。每个叶子是一个窗格，显示一个缓冲区：`sidebar` 占用方、会话窗格、详情窗格，或文件、终端、草稿、摄像头、设置缓冲区。拆分按权重分配空间；侧边栏与详情窗格保持像素宽度。Emacs 风格的组合键用于拆分、关闭、移动与切换窗格，品牌行承载侧边栏开关与 chat/agent 模式切换。窄视口会移除侧边栏窗格，变宽后恢复。

全局面板占据 root 作用域的 `main` keyed slot；`conversation` 是为会话界面保留的 key。每个会话窗格都渲染选中的 `main` 条目。`ctx.layout.selectPanel(id)` 选中已注册面板，`null` 则选中会话界面，但不改变当前会话。Plugins 页面是默认组合中的一个全局面板。`rightbar` 占用方的界面与其他缓冲区无异：它在框架生命周期内始终挂载于一个脱离文档的宿主元素中，显示其缓冲区的窗口（无论用户把它放在哪里）会接管该宿主，并按窗口尺寸设置界面大小。没有窗口为它预留空间。界面展开（`openRightbar`）会在窗口中显示其缓冲区，界面收起（`closeRightbar`）会退出该窗口，显示该缓冲区的窗口会请求界面展开；关闭或移动窗口仍由用户决定。

root 作用域的单一 `shell.bottom` slot 横跨窗口树下方的整行。占用方控制自身高度与显隐；窗格按该高度缩短，空内容不预留空间。切换主面板时保留底部组件，`shell.overlay` 仍覆盖整个框架。默认组合不占用此 slot。

<a id="window-chrome-seat"></a>
### 窗口 chrome 座

框架声明 root 作用域的 `shell.leading` 座（ui-sidebar 以重新打开与 New Session 控件占据），但不渲染它：品牌行在该位置承载侧边栏开关。在 macOS 桌面（`html[data-platform='darwin']`，仅由桌面 preload 设置）下，框架在根元素上发布 `--dsh-frame-top-clearance`（48px）；主面板中的入口型页面以它做顶部内边距。框架自己不声明任何 darwin drag：每个 chrome 行给自身打上 `data-window-drag`，ui-web base.css 把该标记变成唯一那条 darwin drag 规则，于是行自己的盒子就是窗口的可拖几何。框架仅剩的那条 drag 规则属于 Windows 标题栏行。

Windows Electron 的 `data-windows-titlebar` 标记在窗口树上方预留顶栏高度，作为拖动带。普通 Web 文档不会获得该标记；macOS 保留其独立布局。

根元素通过 `--dsh-frame-top-clearance` 发布顶栏占用量（macOS 为 48px，Windows 为标题栏高度），通过 `--dsh-frame-overlay-top` 为弹窗和菜单再留出 20px。原生全屏时浮层起点降为 20px；弹窗仍保留自身 24px 的最小边距。`--dsh-frame-chrome-top` 让模态遮罩不绘制 Windows 顶栏区域，全屏时归零。覆盖整个视口的模态层仍阻挡背景点击。普通浏览器文档不发布这些值。

### 主题呈现

呈现器消费解析后的主题快照，并投影到 document：`html { color-scheme }` 驱动原生 UA 控件，依据当前配色方案设置 `body[data-ds-dark-theme]`，以 `body[data-ds-theme]` 携带当前主题 id 供主题作用域样式表使用，把主题的别名 token、`--dsh-content-font-size`、`--dsh-code-font-size`、`--dsh-terminal-font-size` 以及每个非空的 `--dsh-font-family-<role>` 列表设为 body 上的内联变量，并持有一个 `<meta name="theme-color">`，其内容随计算后的 body 背景色更新。对呈现器执行 dispose（资源释放）时，它会连同其他全局写入一起移除自己的元数据节点。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`selectPanel(id)` 在改变选中态前检查实时 `main` 注册表；缺失的 key 会抛错并保留当前面板。`beginNavigation()` 为异步 UI 导航返回 abort signal。后续调用、有效面板选择（包括重复选择）或布局释放会中止该 signal，但不取消底层会话创建。消费方在提交导航或搬移草稿前检查 signal。

一次注册声明框架的子 slot，并绑定 `ctx.layout` 的 `selectPanel`、`toggleSidebar`、`openRightbar(track, fullscreen)` 与 `closeRightbar`；窗口管理器的附加方法（`IWmLayout`：详情、设置与内联文件窗格）不进入 `ctx.layout` 类型。布局存储保存 `panelInfo` 选中态、窗格宽度偏好与右侧面板的呈现报告；另一个存储保存持久化的窗口树。`ctx.layout.panelInfo` 与标准 `usePanelInfo` hook 共用同一个选中态来源；每个会话窗格只订阅面板 id。`rightbar` owner 提供实际 `width`、`viewportWidth`，以及表示能否以普通模式呈现的 `canShow`；占用方在空间不足时执行确定性的收起，变宽不自行重新展开。全屏隐藏宽度手柄，但不自行释放占用方要求保留的轨道。AppFrame 保持各列容器挂载。右栏的 root 控制器仅在选中会话界面时，经 `SessionProvider` 渲染 `rightbar.session`；内容卸载时的报告释放轨道。独立的标题组件仅在会话界面可见时使用所选会话标题，以构建配置的产品标题或本地化 `common.brand.localBuild` 为回退值；语言变化会更新该回退值。主题呈现器是第二个 effect：从解析后的快照做纯 DOM 写入——初始状态经 getter 读取一次，此后仅事件驱动，不经过 React。它先应用调色板、字号、字体列表与 token 变量，再把渲染出的背景测量为唯一的颜色依据。全屏呈现禁用网格和手柄过渡；占用方完全覆盖框架后才报告新的列布局。退出全屏时，框架先保持无过渡并安装目标布局：关闭移除右轨道，恢复保留右轨道。后续普通几何操作恢复正常过渡。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当布局面不够用时阅读以下页面。它们从框架进入它所渲染的栏与它所呈现的主题。

- [ui-sidebar](../ui-sidebar/README.zh.md)——占据 `sidebar` 栏及其座位。
- [ui-conversation](../ui-conversation/README.zh.md)——占据 `main` 中的 `conversation` key。
- [ui-sidebar-right](../ui-sidebar-right/README.zh.md)——以每会话一个停靠面占据 `rightbar` 栏。
- [ui-theme](../ui-theme/README.zh.md)——呈现器消费其解析快照的主题 seam。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)——浏览器插件行如何加载并注册槽位。

-----

<a id="model-experience"></a>
## 模型体验

无。布局外壳管理浏览器查看状态；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前布局行为。

- **未接通按窗格固定会话**——每个会话窗格都渲染当前会话。要让窗格固定到其他会话，需要为每个窗格保留一个 `SessionReference` 并经 `SessionProvider` 渲染，如同 ui-sidebar-right 保留其会话视图。
- **agent 看板无法中断或提示会话**——0.2 的会话控制器尚无这些操作；相应操作会以具名错误失败，窗格尾部内容与模型标签保持为空。
- **`shell.leading` 已声明但不渲染**——品牌行承载侧边栏开关，因此 ui-sidebar 的前导控件注册后不会挂载。
- **退出右侧面板的窗口后其界面仍为展开状态**——界面保留自己的展开记录，因此在没有窗口显示它时，工具访问它不会重新打开窗口，直到它报告新的展开。
- **框架样式表保留自有圆角**——它们作为包自有的例外登记在共享圆角刻度之外。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
