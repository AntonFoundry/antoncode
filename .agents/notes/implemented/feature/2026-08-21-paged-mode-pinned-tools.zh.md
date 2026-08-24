# Agent Note: Pinned 工具——Paged Mode 中始终携带完整 schema 的工具

Status: implemented

[English](2026-08-21-paged-mode-pinned-tools.md) | 中文

## 问题

Paged Mode 将整个注册表分页在「名称加摘要目录 + `tool_search` 授权循环」之后。这对每个 agent 都是全有或全无的：每个工具在被调用前都要付出一次 `tool_search` 往返，包括部署方明知其模型每一轮都需要的那一小撮工具。对这些「始终在用」的工具而言，往返纯粹是延迟、没有省下任何 token——它们的 schema 无论如何都需要——而长尾工具才真正从分页中受益。分页约定需要一个部署级的「始终已授权」子集：既保留长尾工具的目录，又不强迫常用工具付出一次搜索往返。

## 决策

`dsh-tools` 新增 `pinned?: string[]` 配置，默认 `[]`。在 `paged` 下，pinned 名称会被并入作用域的已授权名称集合，因此它从第一轮起就携带完整 schema，无需 `tool_search` 往返即可直接调用。pinned 名称还会从 `tools:catalog` 段与 `tool_search` 候选列表中排除——已经携带完整 schema 的工具再出现在目录里只是噪声。`native`、`code`、`both` 忽略该字段。

唯一的接缝是 `grantedNames(scope)`：`view()`（可见性）、`collapses()`（直接调用门禁）、`schemas()`、`wireSchemas()` 与 `grantTools()` 都已经经由它流转，因此 pinned 无需任何其他门禁改动——pinned 工具天然变得可见且可调用。`PAGED_ONLY_INSTRUCTION` 保持不变：它原本就写着「已授权工具」，而 pinned 工具等同于预授权。

pinned 授予的是可见性，不是权限。作用域限制仍然会把 pinned 工具从 wire 集合中移除（限制会过滤分页前的能力面，而 `view()` 只保留在该过滤后仍存活、且已授予的名称），解析不到任何已注册工具的 pinned 名称则被忽略。pinned 集合在构造时固定，与随会话不断扩大的各作用域 granted 集合不同。

## 曾考虑的替代方案

- **按 agent 或按 preset 的 pinned 集合**（`presentAs(mode, { pinned })`）：否决。部署级是首要需求。想要常驻始终在线工具的 preset 已经可以通过「paged scope + 一次授权」表达，而给 `presentAs` 增加重载会在有消费者提出需求之前就把概念拆开。
- **根据使用情况自动选择 pinned 集合**：否决。只做显式配置。从使用中推导「始终在用」是 harness 必须解释的启发式，而且会让 wire 集合跨会话变得不确定——这恰好与分页要保留的前缀缓存稳定性背道而驰。
- **独立的 pinned 层，而非并入 `grantedNames`**：否决。`grantedNames` 已经是每个 paged 消费者读取的唯一入口。并行维护一个集合会让可见性门禁（`view`）与直接调用门禁（`collapses`）有漂移的风险，而现有的单接缝设计恰恰在避免这种重复。

## 后果

pinned 工具从第 1 轮起就携带完整 schema，且永远不需要 `tool_search` 往返，而长尾工具保持分页。目录与 `tool_search` 候选列表会减去这些 pinned 名称，因此 pinned 工具不再能通过搜索发现——这可以接受，因为它已经出现在 wire 集合中。该行为由 `paged-mode.spec.ts` 中的 `pinned set` describe 块钉定：第一轮即携带完整 schema、无需授权即可直接执行、不出现在目录段与候选列表中、与动态授权并集而不重复、限制仍会隐藏 pinned 工具，以及 `native`/`code`/`both` 不受影响。

该字段不进入交付默认值（`[]`），因此既有 paged 部署在显式选择之前不会发生任何变化。
