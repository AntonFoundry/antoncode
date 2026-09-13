# @deepseek-ai/dsh-client-ui-jobs

[English](README.md) | 中文

Web 后台任务特性的归属方：向 `conversation.session.header.actions` 贡献一个条目，列出当前会话可见的 `ctx.jobs` 记录。数据完全来自 [`dsh-client-runtime`](../runtime/README.md) 从 `session/jobs` 帧折叠出的 `jobsBySession` 列表镜像；本包唯一发出的 RPC 是停止控件背后的 `jobs.kill`（经 sessions 服务），自有状态止于弹层开合与逐行的停止请求。

只有当会话至少有一个任务时才渲染触发器，普通对话不会因为一项未被使用的能力而长出控件。角标计数为 `running` 加 `stopping`，为零时省略，这样只剩已完成任务的会话保留一个安静的历史入口，而不是宣告一个「零」。弹层是一个扁平列表：活跃行在前按 `startedAt` 升序，随后终态行按 `finishedAt` 降序；毫秒相同的并列按启动顺序打破，宿主的 map 迭代顺序永远不参与决定。一行显示生产者 kind、label、状态标记、生产者一旦给出 `detail` 就取代通用状态词的那段文字，以及已耗时。该耗时在活跃时每秒推进，并在 `finishedAt` 冻结；只有当打开的列表里确实有会动的东西时时钟才运行。缺少 `finishedAt` 的终态行读作零而不是负数，超过一小时的耗时停留在小时单位，不会长出任何生产者目前都到不了的「天」词汇。

终态行保持可见并弱化，直到注册表在 owner 销毁时把它们丢掉。它们本就在快照里，失败任务的 `detail` 是其失败唯一可读之处，在这里过滤掉它们是输出与中断两期要推翻的工作。因此一个运行中的一次性后台 subagent 会同时出现在这里和 [subagent 目录](../ui-subagent/README.md)里：目录负责进入子会话的 transcript，而这个列表是将来中断能力唯一可能附着的句柄。

Escape 关闭列表并把焦点交还触发器，在其外部按下指针同理。最后一个任务消失时先关闭列表再卸载控件，焦点因此不会从一个被移除的节点上凭空消失。样式只用 token；文案走本包自己的 `job` locale 命名空间。行为由 [Web 后台任务展示 Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.md) 与[浏览器终止控件 Agent Note](../../../.agents/notes/implemented/feature/2026-09-14-browser-job-kill-control.md) 规定。

停止控件发出的与模型侧 `job_kill` 工具是同一个 `jobs.kill`：只要有活跃任务，列表开关旁就会出现一个头部停止按钮，一次终止所有活跃任务；每个 `running` 行自带一个行内停止——`stopping` 行不显示，因为取消信号已被受理。某行的按钮在其请求进行期间禁用；失败时把线路错误渲染为按钮 tooltip，按钮保持可重试。该调用按设计是 fire-and-return：行的终结经由下一次 `session/jobs` 变更推送完成，从不经由响应，因此 UI 不持有任务状态的第二事实源。

## 模型体验

无，因为本包为人类渲染宿主计算出的注册表状态，不触及 prompt、消息、schema、流或工具结果。模型对同一批任务的视角仍属于 [`dsh-tool-jobs`](../../jobs/tool-jobs/README.md)。

#### KV Cache effect

无；本包从不组装或发送 provider 请求。

## 已知限制与暂缓事项

- **行无法展示流式输出** —— 任务的流式输出与人类发起的中断曾分为两期；中断已经落地（上文的停止控件，走 `jobs.kill`），而输出流式仍是面向模型的一期，列表有意不进入。
- **列表不等于注册表自己的集合** —— 它展示的是「一个会话通过线路视图能看到什么」，所以别的会话拥有的任务在这里永远不出现；而进程重启会清空列表，transcript 里启动这些任务的 `run_in_background` 卡片却还在。无主任务（在没有活体 `Agent` 时启动的）是反过来的情形：它会进入每一个会话的列表，与 `list(caller)` 对每个调用方的报告一致。
