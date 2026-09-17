# @deepseek-ai/dsh-gate-policy

[English](README.md) | 中文

工具执行路径上的"先回答后放行"闸门。每条规则由触发条件（工具名通配模式加`command` 参数上的锚定正则）和一份检查清单组成。调用命中时闸门拒绝该调用，清单作为拒绝理由返回——模型将其作为工具结果读取，执行检查、陈述结果，然后原样重试。闸门从不批准任何操作；它只能在检查被陈述之前阻止调用。决策记录：[guidebook-gates-and-recipes Agent Note](../../../.agents/notes/proposed/feature/2026-09-13-guidebook-gates-and-recipes.md)。

插件只提供机制。哪些动作被拦截、清单要求什么，属于 `cordis.yml` 中的部署策略——没有任何硬编码。

## Config

```yaml
- id: gate-policyname: '@deepseek-ai/dsh-gate-policy'config:rules:- name: push-gatetools: [bash]                  # default; *-wildcard tool-name patternscommandPatterns: ['git\s+push(?!.*--dry-run)']checklist: |-- Run the test suite and show it passing- Re-state what is being pushed and why
```

`rules` 默认为 `[]`——没有规则的部署不拦截任何调用。规则字段：

| 字段 | 含义 |
|---|---|
| `name` | 必填且非空。拒绝文本中引用，使转录能点名闸门。 |
| `tools` | 工具名上的 `*` 通配模式；默认 `['bash']`。 |
| `commandPatterns` | 针对 `command` 字符串参数测试的锚定正则。第一条命中的规则拒绝。 |
| `checklist` | 必填且非空。模型重试前必须完成的检查。 |

配置错误在插件加载时显式失败：非法正则、空规则名或空清单都会抛出。没有字符串 `command` 参数的调用永不命中——闸门以 shell 命令文本为键，不猜测其他参数形态。

## Model Experience

被拦截的调用增加一条被拒的工具结果（`Error: Gate '<name>' blocked this call. … retry this exact call.`），随后通常是检查输出和一次成功的重试——每个被拦截的动作只有一次有界开销。未命中的调用不受影响：guard 返回 `undefined`，不添加任何文本、状态或延迟。

## Known Limitations and Deferred Work

- 触发匹配的是字面命令文本；模型可能通过包装动作（在其他工具内 `bash -c`、脚本文件）绕过闸门。自行执行检查的 verified gate 被推迟；当前的强制力依赖模型在转录中陈述其检查。
- 只检查 `command` 参数；危险参数在别处的工具需要各自的闸门表面。
