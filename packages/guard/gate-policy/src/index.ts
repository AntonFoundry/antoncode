/**
 * Gate policy guard: denies tool calls whose arguments match a configured
 * dangerous-action pattern, returning the rule's checklist as the denial
 * reason so the model reads it as the tool result, performs the checks, and
 * retries. Rules are deployment configuration — the plugin ships mechanism
 * only. Semantics live in the package README; the decision record is the
 * guidebook-gates-and-recipes Agent Note.
 * @module @deepseek-ai/dsh-gate-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// Type-only: merges the `todo/write` and `plan/write` declarations into
// SessionEventMap so this unit's fold can switch on them. The gate stays inert
// when neither plugin is composed, so neither is a runtime dependency.
import type {} from '@deepseek-ai/dsh-tool-todo'
import type {} from '@deepseek-ai/dsh-plan-mode'

export const name = 'gate-policy'

/**
 * The guard registers against the tool runtime and reads its own session
 * projection, so both services are hard dependencies.
 *
 * The plan gate's knobs live in this plugin's own `Config`: a Settings edit
 * reloads the entry and re-applies the plugin, so there is no second live
 * settings source to keep in step.
 */
export const inject = ['tools', 'sessionProjections']

/** One gate rule: a trigger over tool name plus command text, and the checklist to satisfy first. */
export interface GateRule {
  /** Rule identifier, quoted in the denial so the model and the log name the gate. */
  name: string
  /** `*`-wildcard patterns over the tool name (default `['bash']`). */
  tools?: string[]
  /** Anchored-regex sources tested against the call's `command` argument; first match wins. */
  commandPatterns: string[]
  /** The checks the model must perform and state before retrying the call. */
  checklist: string
  /**
   * Route the match through the user-approval UI instead of denying: the
   * human sees the gate (rule, checklist, command context) and answers
   * allow-once or deny. Allowed calls proceed untouched; denials and any
   * approval-channel failure fall back to the checklist denial text. The
   * ask bypasses the session approval policy — a gate confirmation is
   * deployment-mandated, not a model-initiated ask.
   */
  confirm?: boolean
}

/**
 * The todo-plan gate's configuration: when enabled, the gated tools are
 * denied until the calling session carries a todo plan (a `todo/write`
 * event anywhere in its log). `todo_write` itself is never gated — it is
 * how the gate is satisfied.
 */
export interface TodoPlanGateConfig {
  /** Enable the plan gate. Defaults to `false`. */
  enabled?: boolean
  /** Tools gated until a todo plan exists. Defaults to `['bash', 'edit', 'write', 'multiedit']`. */
  tools?: string[]
  /** Whether an implementation plan is required when a large todo tree is present. Defaults to `true`. */
  requireImplementationPlan?: boolean
  /** Threshold of total todos (root + nested) to require an implementation plan via plan_write or exit_plan_mode. Defaults to `3`. */
  minTodosForImplementationPlan?: number
}

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: an invalid regex,
 * an empty rule name, or an empty checklist throws at plugin load, never a
 * silent fall-back). An empty `rules` list is valid and means no gate fires.
 */
export interface Config {
  /** Gate rules; evaluated in order, and the first matching rule denies. */
  rules?: GateRule[]
  /** The todo-plan gate: gated tools are denied until the session has a todo plan. Defaults to disabled. */
  todoPlanGate?: TodoPlanGateConfig
  /** Pre-fetch c0ntext guidebook recipes and append matching ones to denials. Defaults to `false`. */
  verdictsEnabled?: boolean
  /** Base URL of the c0ntext worker, e.g. `http://127.0.0.1:8090`. Verdicts are inert without it. */
  verdictsEndpoint?: string
  /** c0ntext API key sent as `X-API-Key`. Empty for a keyless local worker. */
  verdictsApiKey?: string
  /** Environment variable that overrides `verdictsApiKey`. Defaults to `ANTON_CONTEXT_API_KEY`. */
  verdictsApiKeyEnv?: string
  /** Per-request timeout for `GET /recipes/list`. Defaults to `4000`. */
  verdictsTimeoutMs?: number
  /** Refresh interval for the recipe cache. Defaults to `300000`. */
  verdictsRefreshMs?: number
}

export const Config: z<Config> = z.object({
  rules: z.array(z.object({
    name: z.string(),
    tools: z.array(z.string()).default(['bash']),
    commandPatterns: z.array(z.string()),
    checklist: z.string(),
    confirm: z.boolean().default(false),
  })).default([]),
  todoPlanGate: z.object({
    enabled: z.boolean(),
    tools: z.array(z.string()),
    requireImplementationPlan: z.boolean().default(true),
    minTodosForImplementationPlan: z.number().default(3),
  }).default({ enabled: false, tools: ['bash', 'edit', 'write', 'multiedit'], requireImplementationPlan: true, minTodosForImplementationPlan: 3 }),
  verdictsEnabled: z.boolean().default(false),
  verdictsEndpoint: z.string().default(''),
  verdictsApiKey: z.string().default(''),
  verdictsApiKeyEnv: z.string().default('ANTON_CONTEXT_API_KEY'),
  verdictsTimeoutMs: z.number().default(4000),
  verdictsRefreshMs: z.number().default(300000),
})

/** One cached guidebook recipe: only the id and intent reach the guard. */
export interface RecipeSummary {
  id: string
  intent: string
}

/** Compile one `*`-wildcard pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** The model-facing denial: names the gate, lists the checks, orders the retry. */
function denialText(ruleName: string, checklist: string, guidebook: readonly RecipeSummary[]): string {
  let text = `Gate '${ruleName}' blocked this call. Before it can run, complete these checks:\n`
    + `${checklist}\n`
    + 'Perform the checks now, state their outcome in your reply, then retry this exact call.'
  if (guidebook.length > 0) {
    text += '\n\nGuidebook — stored recipes whose intent matches this gate:\n'
      + guidebook.map(recipe => `- ${recipe.intent}`).join('\n')
  }
  return text
}

/** Lowercase alphanumeric tokens of length ≥ 3 — the matcher vocabulary; shorter words are noise. */
function keywords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(token => token.length >= 3))
}

/**
 * Deterministic token-overlap matcher: a recipe matches when its intent shares
 * at least one token with the rule name or the checklist. No scoring, no
 * ranking — the c0ntext engine owns relevance; the guard only narrows.
 * @param recipes - Recipe summaries to filter without modifying their entries.
 * @param ruleName - Rule name whose lowercase alphanumeric tokens participate in matching.
 * @param checklist - Required checks matched against each recipe intent using tokens of at least three characters.
 * @returns Matching summaries in their original order, preserving the input entry references.
 */
export function matchingRecipes(recipes: readonly RecipeSummary[], ruleName: string, checklist: string): RecipeSummary[] {
  const gate = new Set([...keywords(ruleName), ...keywords(checklist)])
  return recipes.filter(recipe => [...keywords(recipe.intent)].some(token => gate.has(token)))
}

/**
 * Fetch the guidebook inventory from the c0ntext worker and reduce it to the
 * id/intent pairs the matcher reads. Non-string entries are skipped; a failed
 * or malformed response throws so the caller can decide the fallback.
 */
async function fetchRecipes(baseUrl: string, apiKey: string, timeoutMs: number): Promise<RecipeSummary[]> {
  const response = await fetch(`${baseUrl}/recipes/list?project_id=global`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: apiKey === '' ? {} : { 'x-api-key': apiKey },
  })
  if (!response.ok) throw new Error(`recipes/list responded ${response.status}`)
  const payload: unknown = await response.json()
  if (!Array.isArray(payload)) throw new Error('recipes/list returned a non-array payload')
  const recipes: RecipeSummary[] = []
  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = (entry as { id?: unknown }).id
    const intent = (entry as { intent?: unknown }).intent
    if (typeof id === 'string' && typeof intent === 'string') recipes.push({ id, intent })
  }
  return recipes
}

/**
 * The command text a gate evaluates: the call's `command` argument when it is
 * a string. Tools without a string `command` argument never match — gates key
 * on shell command text, and guessing at other argument shapes would gate on
 * coincidence.
 */
function commandText(execution: Readonly<ToolExecution>): string | undefined {
  const command = (execution.arguments as Record<string, unknown> | undefined)?.command
  return typeof command === 'string' ? command : undefined
}

/** A compiled rule: the tool-name predicate, the command regexes, and the checklist. */
interface CompiledRule {
  name: string
  tools: RegExp[]
  patterns: RegExp[]
  checklist: string
  confirm: boolean
}

/**
 * Validate and compile the configured rules. A rule with an empty
 * `commandPatterns` list would fire on every matching tool call, which is a
 * legitimate deployment choice for a hard stop, so it is allowed; only
 * malformed regexes, empty names, and empty checklists fail load.
 */
function compileRules(rules: GateRule[]): CompiledRule[] {
  return rules.map((rule) => {
    if (rule.name.length === 0) throw new Error('gate-policy: every rule needs a non-empty `name`')
    if (rule.checklist.trim().length === 0) {
      throw new Error(`gate-policy: rule '${rule.name}' needs a non-empty \`checklist\``)
    }
    let patterns: RegExp[]
    try {
      patterns = rule.commandPatterns.map(source => new RegExp(source))
    } catch (error) {
      throw new Error(`gate-policy: rule '${rule.name}' has an invalid \`commandPatterns\` entry: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { name: rule.name, tools: (rule.tools ?? ['bash']).map(wildcardToRegExp), patterns, checklist: rule.checklist, confirm: rule.confirm ?? false }
  })
}

/**
 * Total number of todos in a todo tree, counting top-level items and recursive children.
 * @param todos - unknown todo items array or tree.
 * @returns the total count of todo items.
 */
export function countTodos(todos: unknown): number {
  if (!Array.isArray(todos)) return 0
  let count = 0
  for (const item of todos) {
    if (item !== null && typeof item === 'object') {
      count += 1
      if ('children' in item && Array.isArray((item as { children?: unknown }).children)) {
        count += countTodos((item as { children?: unknown }).children)
      }
    }
  }
  return count
}

/**
 * The plan gate's fixed-size view of a Session: whether a todo tree exists,
 * how large it is, and whether an implementation plan was recorded.
 */
export interface PlanGateState {
  hasTodo: boolean
  todoCount: number
  hasImplementationPlan: boolean
}

const planGateStateSchema: ZodType<PlanGateState> = zod.object({
  hasTodo: zod.boolean(),
  todoCount: zod.number(),
  hasImplementationPlan: zod.boolean(),
}).strict()

/**
 * A host-only projection the gate owns, rather than reading another unit's
 * state: the guard runs synchronously on every tool call, so it needs these
 * three facts already folded, and they stay fixed-size however long the log
 * grows.
 */
export const planGateProjectionDefinition = {
  key: 'gatePolicyPlan',
  stateVersion: 1,
  stateSchema: planGateStateSchema,
  init: () => ({ hasTodo: false, todoCount: 0, hasImplementationPlan: false }),
  apply: (state, event) => {
    if (event.type === 'todo/write' || event.type === 'todo/tree-write') {
      const todoCount = countTodos((event.data as { todos?: unknown }).todos)
      return state.hasTodo && state.todoCount === todoCount ? state : { ...state, hasTodo: true, todoCount }
    }
    if (event.type === 'plan/write') {
      return state.hasImplementationPlan ? state : { ...state, hasImplementationPlan: true }
    }
    return state
  },
} satisfies ProjectionDefinition<'gatePolicyPlan', PlanGateState>

/**
 * Install the guard's registrations.
 * @param ctx - plugin context; every registration is scoped to it and disposed with it.
 * @param config - validated {@link Config}; rules are re-compiled fail-loud here.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const rules = compileRules(config.rules as GateRule[])

  const gate = {
    enabled: config.todoPlanGate?.enabled ?? false,
    tools: [...(config.todoPlanGate?.tools ?? ['bash', 'edit', 'write', 'multiedit'])].map(wildcardToRegExp),
    requireImplementationPlan: config.todoPlanGate?.requireImplementationPlan ?? true,
    minTodos: config.todoPlanGate?.minTodosForImplementationPlan ?? 3,
  }

  // Awaited before any guard is registered: a synchronous guard cannot fold the
  // log itself, and a rejected registration must fail this activation rather
  // than leave a gate that silently never fires.
  const planGate = await ctx.sessionProjections.register(planGateProjectionDefinition)

  const todoPlanDenial = (toolName: string): string =>
    'Gate \'todo-plan\' blocked this call. No plan exists in the todo tree yet. '
    + 'Call todo_write with your plan — top-level tasks for the phases, children for the concrete subtasks — '
    + `then retry \`${toolName}\`. todo_write itself is never gated.`

  const implementationPlanDenial = (toolName: string, todoCount: number, minTodos: number): string =>
    `Gate 'todo-plan' blocked this call. Your todo tree contains ${todoCount} tasks (threshold: ${minTodos}), `
    + 'which indicates a non-trivial project: a detailed implementation plan must be recorded BEFORE the todo tree '
    + 'grows past this threshold. Record it now with `plan_write` (or an approved `exit_plan_mode`), and link the plan '
    + 'artifact (e.g. `implementation_plan.md`). Delegate codebase exploration to a `subagent` to draft the plan while '
    + 'delegation works, but never stall on a failed or unavailable subagent: author the plan from current knowledge '
    + `and record it. Then retry \`${toolName}\`. \`subagent\` and \`plan_write\` are never gated.`

  /**
   * The gate's own projection, or undefined for an agent-less call. The gate
   * fails OPEN without a session: a discipline nudge must never break a call
   * it cannot evaluate.
   */
  const planGateState = (execution: Readonly<ToolExecution>): PlanGateState | undefined => {
    const session = execution.agent?.session
    return session === undefined ? undefined : planGate.stateOf(session)
  }

  const todoPlanGuard: ToolGuard = (execution: Readonly<ToolExecution>): string | undefined => {
    if (!gate.enabled) return undefined
    if (execution.name === 'todo_write' || execution.name === 'plan_write' || execution.name === 'subagent') return undefined
    if (!gate.tools.some(pattern => pattern.test(execution.name))) return undefined
    const state = planGateState(execution)
    if (state === undefined) return undefined
    if (!state.hasTodo) return todoPlanDenial(execution.name)
    if (gate.requireImplementationPlan && state.todoCount >= gate.minTodos && !state.hasImplementationPlan) {
      return implementationPlanDenial(execution.name, state.todoCount, gate.minTodos)
    }
    return undefined
  }

  ctx.effect(() => ctx.tools.guard(todoPlanGuard))


  /**
   * The guidebook cache: verdicts are pre-fetched on an interval because the
   * guard is synchronous. An empty or failed cache leaves denials unchanged —
   * telemetry must never cost a run, so fetch failures are swallowed after
   * logging.
   */
  let cache: RecipeSummary[] = []
  if (config.verdictsEnabled === true && (config.verdictsEndpoint ?? '').trim() !== '') {
    const baseUrl = (config.verdictsEndpoint ?? '').replace(/\/$/, '')
    const override = process.env[config.verdictsApiKeyEnv ?? 'ANTON_CONTEXT_API_KEY']?.trim()
    const apiKey = override === undefined || override === '' ? config.verdictsApiKey ?? '' : override
    const timeoutMs = config.verdictsTimeoutMs ?? 4000
    const refreshMs = config.verdictsRefreshMs ?? 300000
    const refresh = (): void => {
      fetchRecipes(baseUrl, apiKey, timeoutMs).then((recipes) => {
        cache = recipes
      }).catch((error: unknown) => {
        // Keep the previous cache; a degraded engine must not break gating.
        ctx.logger?.warn('gate-policy: guidebook refresh failed, keeping last cache: %s', error instanceof Error ? error.message : String(error))
      })
    }
    refresh()
    ctx.effect(() => {
      const timer = setInterval(refresh, refreshMs)
      return () => clearInterval(timer)
    })
  }

  /** The first rule matching this call, or undefined when none does. */
  const matchRule = (execution: Readonly<ToolExecution>): { rule: CompiledRule; command: string } | undefined => {
    const command = commandText(execution)
    if (command === undefined) return undefined
    for (const rule of rules) {
      if (!rule.tools.some(pattern => pattern.test(execution.name))) continue
      if (!rule.patterns.some(pattern => pattern.test(command))) continue
      return { rule, command }
    }
    return undefined
  }

  /**
   * Confirmable rules resolve in the pre-execute waterfall, which may await;
   * `ask` hands the decision to the shared approval pipeline rather than this
   * plugin driving an approval channel itself. A denied ask becomes the
   * pipeline's denial, so the gate does not restate it.
   */
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const matched = matchRule(exec)
    if (matched === undefined || !matched.rule.confirm) return next()
    return {
      kind: 'ask',
      reason: `Gate '${matched.rule.name}' matched this call and asks for your confirmation.\n\nCommand:\n${matched.command}\n\n${matched.rule.checklist}`,
    }
  })

  /**
   * The synchronous guard: a matching non-confirm rule denies with its
   * checklist; a confirm rule has already been settled by the waterfall above,
   * so it passes through untouched.
   */
  const guard: ToolGuard = (execution: Readonly<ToolExecution>): string | undefined => {
    const matched = matchRule(execution)
    if (matched === undefined || matched.rule.confirm) return undefined
    return denialText(matched.rule.name, matched.rule.checklist, matchingRecipes(cache, matched.rule.name, matched.rule.checklist))
  }

  ctx.effect(() => ctx.tools.guard(guard))
}
