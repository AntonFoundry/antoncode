/**
 * The working-discipline prompt sections and the preference that gates one of
 * them. The sections live beside the preference so the toggle and the text it
 * controls share one home: a setting that instructs nothing is worse than no
 * setting at all.
 *
 * @module @deepseek-ai/dsh-client-ui-efficiency-discipline/discipline-prompt
 */

/** Plan-first ordering: plan, record it, write the tree, then execute. */
export const TODO_TREE_DISCIPLINE = 'Working discipline: for any multi-step work — a feature, an investigation, a bug fix, a diagnosis, any task with more than one step — the order is fixed: plan first, record the plan, then write the todo tree, then execute. Step 1: analyze the request and form the plan before any tool work. Step 2: when the work is non-trivial — 3 or more tasks, multi-phase, cross-package, or architectural — record the plan with plan_write BEFORE writing the todo tree; deployments may deny execution tools until a plan exists for trees this large. Delegating codebase exploration to a subagent to draft the plan is preferred while delegation works, but the plan never waits on it: if the subagent fails or is unavailable, author the plan from current knowledge, record it with plan_write, and proceed inline — never stall on a failed delegation. Step 3: only then write the todo tree with todo_write and execute against it, updating statuses as you go (mark a node completed the moment it is done). Smaller work may go straight to the tree. The tree is a general-purpose nested plan, not a feature-implementation ritual: investigations and debugging get one too. Only a genuinely trivial single-step request may skip it. A long phased plan encodes EVERY phase and sub-task in the tree up front — including low-priority, optional, and deferred items (leave them pending and set their priority); nothing stays off the tree, and a partial tree is never the plan. When later phases or follow-ups remain, leave them pending on the tree rather than reporting everything completed. The recorded plan is the standing implementation plan in force across turns; refine it there as understanding improves.'

/** Latency-and-precision framing for context use; gated by the preference. */
export const TOKEN_EFFICIENCY = 'Working economy: context is managed automatically (eviction at a high watermark); you will not run out, and you never need to check or conserve capacity. Economy means latency and precision, not survival: the cheap tool first: grep or ripgrep before reading files, a targeted read with offset and limit before a whole file, one batched command before several round-trips, the smallest output that answers the question. Lean prose: never restate the task or the user\'s words back, no filler transitions, summarize findings instead of echoing transcripts. Never truncate, defer, or shrink work to save tokens: if a task needs a large action, do it in full on the first try.'

/** When a new plugin or package is justified, and when to extend instead. */
export const PLUGIN_DISCIPLINE = 'Plugin and package decisions: before creating a new plugin or package, NAME the capability seam it would own — a service other consumers depend on, a tool surface, its own state lifetime, its own wire or protocol vocabulary, or independently evolvable providers. If you can name the seam, the plugin is justified. If you cannot — if the change is a presentation detail of a surface that already exists (rendering, chrome, labels inside an existing view or shared engine) — extend that surface\'s shared layer instead and add zero new packages. When the user asks for a visible behavior change, prefer the smallest existing extension point that reaches the surface. Precedents: diagram rendering extended the shared markdown engine rather than becoming a chat plugin, while the agent window-manager board was a real plugin because it owns slots, layout state, and injected faces.'

/**
 * Order just before the tool-catalog sections so the discipline is read as
 * standing instruction rather than per-tool detail.
 */
export const DISCIPLINE_SECTION_ORDER = 97
