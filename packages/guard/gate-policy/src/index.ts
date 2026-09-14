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

export const name = 'gate-policy'

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
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: an invalid regex,
 * an empty rule name, or an empty checklist throws at plugin load, never a
 * silent fall-back). An empty `rules` list is valid and means no gate fires.
 */
export interface Config {
  /** Gate rules; evaluated in order, and the first matching rule denies. */
  rules?: GateRule[]
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
 * Install the guard's registration.
 * @param ctx - plugin context; the guard registration is scoped to it and disposed with it.
 * @param config - validated {@link Config}; rules are re-compiled fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const rules = compileRules(config.rules as GateRule[])

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
