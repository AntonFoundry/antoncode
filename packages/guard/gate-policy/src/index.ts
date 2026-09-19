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
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'gate-policy'

/** The settings namespace the plan gate reads live (Settings → Plugins → Gate policy). */
export const GATE_POLICY_SETTINGS_NAMESPACE = settingsNamespace('gate-policy')

/** Schemastery section schema the settings registry validates the card writes against. */
export const TodoPlanSectionSchema = z.object({
  enabled: z.boolean(),
  tools: z.array(z.string()),
  requireImplementationPlan: z.boolean().default(true),
  minTodosForImplementationPlan: z.number().default(3),
})

/** The guard registers against the tool runtime, so the service is a hard dependency. */
export const inject = ['tools']

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

/** The flat section the Settings card edits: the todo-plan gate. */
export interface TodoPlanGateSection {
  enabled: boolean
  tools: string[]
  requireImplementationPlan?: boolean
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
 * Install the guard's registration.
 * @param ctx - plugin context; the guard registration is scoped to it and disposed with it.
 * @param config - validated {@link Config}; rules are re-compiled fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  let rules = compileRules(config.rules as GateRule[])

  /**
   * Settings section: the plan gate (and future guard knobs) read live, so a
   * Settings edit takes effect on the next call without re-composing. The
   * section is seeded from the composition entry; `todo_write` itself is
   * never gated (it is how the gate is satisfied), and a session read
   * failure fails OPEN: a discipline nudge must not break execution when the
   * log is unreadable.
   */
  const sectionSeed: TodoPlanGateSection = {
    enabled: config.todoPlanGate?.enabled ?? false,
    tools: [...(config.todoPlanGate?.tools ?? ['bash', 'edit', 'write', 'multiedit'])],
    requireImplementationPlan: config.todoPlanGate?.requireImplementationPlan ?? true,
    minTodosForImplementationPlan: config.todoPlanGate?.minTodosForImplementationPlan ?? 3,
  }
  let live: () => TodoPlanGateSection = () => sectionSeed
  installSettingsSection(
    ctx,
    GATE_POLICY_SETTINGS_NAMESPACE,
    TodoPlanSectionSchema as unknown as z<TodoPlanGateSection>,
    sectionSeed,
    {
      setSource: (source) => { live = source as () => TodoPlanGateSection },
      onChange: () => {
        rules = compileRules((live() as unknown as { rules?: GateRule[] }).rules ?? [])
      },
    },
  )

  const todoPlanDenial = (toolName: string): string =>
    'Gate \'todo-plan\' blocked this call. No plan exists in the todo tree yet. '
    + 'Call todo_write with your plan — top-level tasks for the phases, children for the concrete subtasks — '
    + `then retry \`${toolName}\`. todo_write itself is never gated.`

  const implementationPlanDenial = (toolName: string, todoCount: number, minTodos: number): string =>
    `Gate 'todo-plan' blocked this call. Your todo tree contains ${todoCount} tasks (threshold: ${minTodos}), `
    + 'which indicates a non-trivial project. For tasks of this scale, you must create a detailed implementation plan first. '
    + 'Delegate codebase exploration and plan authoring to a subagent (using `subagent`) to preserve context, '
    + 'record the plan with `plan_write` (or `exit_plan_mode`), and link the plan artifact (e.g. `implementation_plan.md`). '
    + `Then retry \`${toolName}\`. \`subagent\` and \`plan_write\` are never gated.`

  const getTodoPlanState = (execution: Readonly<ToolExecution>):
  { hasTodo: boolean; todoCount: number; hasImplementationPlan: boolean } => {
    try {
      const agent = (
        execution as { agent?: { session?: { events?: readonly { type?: string; data?: unknown }[] } } }
      ).agent
      const events = agent?.session?.events
      if (events === undefined) return { hasTodo: true, todoCount: 0, hasImplementationPlan: true } // unreadable log fails open
      let hasTodo = false
      let todoCount = 0
      let hasImplementationPlan = false
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        if (event === undefined) continue
        if (event.type === 'plan/write') {
          hasImplementationPlan = true
        }
        if (!hasTodo && event.type === 'todo/write') {
          hasTodo = true
          const data = event.data as { todos?: unknown } | undefined
          todoCount = countTodos(data?.todos)
        }
      }
      return { hasTodo, todoCount, hasImplementationPlan }
    } catch {
      // fail open: the gate must never break execution on its own failure
      return { hasTodo: true, todoCount: 0, hasImplementationPlan: true }
    }
  }

  const todoPlanGuard: ToolGuard = (execution: Readonly<ToolExecution>): string | undefined => {
    const gate = live()
    if (gate.enabled !== true) return undefined
    if (execution.name === 'todo_write' || execution.name === 'plan_write' || execution.name === 'subagent') return undefined
    const tools = (gate.tools ?? ['bash', 'edit', 'write', 'multiedit']).map(wildcardToRegExp)
    if (!tools.some(pattern => pattern.test(execution.name))) return undefined
    const { hasTodo, todoCount, hasImplementationPlan } = getTodoPlanState(execution)
    if (!hasTodo) return todoPlanDenial(execution.name)
    const requireImplPlan = gate.requireImplementationPlan ?? true
    const minTodos = gate.minTodosForImplementationPlan ?? 3
    if (requireImplPlan && todoCount >= minTodos && !hasImplementationPlan) {
      return implementationPlanDenial(execution.name, todoCount, minTodos)
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

  /**
   * The guard: first matching rule denies with its checklist; everything else
   * returns `undefined` and the call proceeds untouched. Registration returns
   * a disposer, so the effect disposes with the plugin fiber.
   */
  const guard: ToolGuard = async (execution: Readonly<ToolExecution>): Promise<string | undefined> => {
    const command = commandText(execution)
    if (command === undefined) return undefined
    for (const rule of rules) {
      if (!rule.tools.some(pattern => pattern.test(execution.name))) continue
      if (!rule.patterns.some(pattern => pattern.test(command))) continue
      const denial = denialText(rule.name, rule.checklist, matchingRecipes(cache, rule.name, rule.checklist))
      if (!rule.confirm) return denial
      // Resolve the approval service lazily, at call time: this plugin only
      // waits on `tools`, so at apply time the approval service may not have
      // mounted yet and an apply-time `ctx.get` would be undefined forever.
      // Absent service (bare tool-registry tests) or agent falls back to the
      // plain checklist denial rather than failing the call.
      const approval = ctx.get('approval') as
        | { request(req: { agent: Agent; toolName: string; reason?: string; bypassPolicy?: boolean }): Promise<string> }
        | undefined
      if (approval === undefined || execution.agent === undefined) return denial
      try {
        const outcome = await approval.request({
          agent: execution.agent,
          toolName: execution.name,
          reason: `Gate '${rule.name}' matched this call and asks for your confirmation.\n\nCommand:\n${command}\n\n${rule.checklist}`,
          bypassPolicy: true,
        })
        // Only an explicit allow proceeds; rejected/cancelled/unavailable deny.
        if (outcome === 'allowed-once') return undefined
      } catch {
        // Fail closed: an approval-channel failure denies with the checklist.
      }
      return denial
    }
    return undefined
  }

  ctx.effect(() => ctx.tools.guard(guard))
}
