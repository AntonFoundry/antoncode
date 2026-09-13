# Agent Note：后台任务的浏览器终止控件

状态：已实现

[English](2026-09-14-browser-job-kill-control.md) | 中文

## 问题

会话头部的任务卡片只能看着后台任务死掉。模型侧的 `job_kill` 工具能到达 `JobRegistry.kill()`，`session/jobs` mux 帧也让浏览器的镜像时刻保鲜，但 apiproxy 没有任何客户端可调用的终止方法——一个看到游离 `sleep 300` 行的人既不能停掉它，甚至无法请求宿主去停。唯一的终止权限隔在玻璃的另一侧。

## 决策

照兄弟方法的模板抄一个 unary 方法，加上触达它的最小 UI：

- **契约**（`dsh-host-apiproxy/api`）：新 `jobs` 域中的 `JobsApi.kill(request: RpcRequest<{ jobId: JobId }>): Promise<RpcResponse<{ killed: 'requested' | 'already-finished' }>>` —— `RpcMethodMap` 一行、`ApiProxy` 一个字段、payload 直达式的 `IAIClient.jobs.kill`、请求/响应 zod schema，以及两张分派表。`RpcErrorDetailsMap` 与错误 schema 加入两个错误码：`job-not-found`（终结的任务会离开存储）与 `jobs-unavailable`（未组合注册表；沿 term 域先例）。
- **处理器**：浏览器不是注册表调用方，因此处理器对无主任务走无 caller 的栅栏直接终止，对有主任务在活跃会话的 agent 中解析其 owner。栅栏在任何变更之前抛错（未知 id、他人任务），所以探测调用方没有副作用；所有尝试都抛则折叠为 `job-not-found`。connection fixture 与包内两个 carrier fixture 照 `term` 的方式补上 `jobs` 行。
- **对象层**：`ISessions.killJob`/`SessionManager.killJob` 包装裸线路调用，与 `interruptSession`/`cancelSession` 并列。Fire-and-return：行经由下一次 `session/jobs` 变更推送终结，从不经由本次结果。
- **UI**（`ui-jobs`）：register 调用获得携带一个 `killJob` 回调（走 `ctx.sessions`）的 inject face；组件保持纯 props。卡片头部在存在活跃任务时于列表开关旁长出一个停止按钮（全部停止），每个 `running` 行长出各自的行内停止——`stopping` 行不显示，因为取消信号已被受理。行按钮在其请求进行期间禁用；失败以按钮 tooltip（`stop.failed`）呈现并保持可重试。除两个按钮外无新增 chrome；与所有兄弟 unary 方法一致，无需审批。

## 测试

处理器层：`api-proxy-jobs` 覆盖经 owner 解析终止有主任务、无 caller 终止无主任务、对已终结任务回答 `already-finished`，以及拒绝未知 id 与无注册表组合。组件层：头部停止只在有活跃任务时出现且逐一终止；行内停止携带正确的 id；`stopping` 行没有按钮；进行中的请求禁用按钮；失败落入 tooltip 并恢复可重试。`background-job-list` web e2e 现在经由行内停止按钮驱动终结——UI → `jobs.kill` → 注册表 kill → 变更推送——其 `running` golden 把按钮钉在 listitem 内。

## 已考虑的替代方案

**成对的通用 `jobs.list` + kill。** 读侧已存在且在浏览器里严格更优：mux 推送无需询问即到达并携带全量集合，可轮询的列表只会为同一事实增加第二个事实源。

**复用 `session.cancel`。** 不同的注册表、不同的权限形态——`sessions.cancel` 停的是 agent 的轮次；任务是会话对象层从未见过的进程句柄。域方法让两条 seam 各自诚实。

**payload 里带 session 的按会话终止。** 处理器从任务 id 推导 owner 使线路保持最小，并让同一端点无需客户端了解调用方栅栏即可服务有主与无主两类行。

## 后果

人现在可以停止卡片已展示的任何任务，其权限与卡片数据所乘的通道对等。模型侧与浏览器侧的终止路径对称，任何一侧都不能比另一侧多做分毫。注册表栅栏保持原样：浏览器无法指名其可见集合之外的任务，也无法以错误 owner 终止——解析 owner 的是处理器，不是客户端。
