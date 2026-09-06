# Agent Note：窗格标题栏的 tidy/flip/expand 与焦点窗格强调色
[English](2026-09-06-pane-header-tidy-flip-expand.md) | 中文


状态：已实现

## 问题

窗格操作此前只有快捷键（C-x 1 / M-x），BridgeMind 风格的平铺布局没有可见的每窗格控件——且多窗格布局中焦点窗格的标题栏毫无区分，难以阅读。

## 决策

- 每个窗格的 mode line 在 Close 旁新增三个按钮：**Tidy**（递归地将所有分屏权重均衡为等份——`tidyTree`）、**Flip**（在父分屏内与兄弟窗格交换位置，权重随窗格走——`flipWithSibling`）、**Expand**（仅保留此叶——即标题栏中的 C-x 1 语义，`keepOnlyLeaf` 加焦点）。`M-x tidy-panes` 与 `M-x flip-pane` 进入命令表。
- 焦点窗格的 mode line 携带主题强调色：brand-primary 顶部内嵌线、抬升背景、品牌色染色的缓冲区名。非焦点窗格保持原样。基于令牌（`--dsw-alias-*`），每个注册主题都会重新着色。

## 已考虑的替代方案

**通过逐个关闭兄弟窗格实现 Expand。** 否决：`keepOnlyLeaf` 就是既有的 C-x 1 变换——一次操作，无中间状态。

**Tidy/Flip 仅放入 M-x。** 否决：平铺 code 模式的意义在于 point-and-click 的窗格管理；命令保留给键盘用户。

## 后果

- mode line 现最多承载六个按钮；窄窗格可能先截断标题（按钮在 flex 竞争中获胜）。
- 无兄弟窗格的 Flip 是返回原树的无操作。
