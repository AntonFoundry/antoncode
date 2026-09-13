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
}

export const Config: z<Config> = z.object({
  rules: z.array(z.object({
    name: z.string(),
    tools: z.array(z.string()).default(['bash']),
    commandPatterns: z.array(z.string()),
    checklist: z.string(),
  })).default([]),
})

/** Compile one `*`-wildcard pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** The model-facing denial: names the gate, lists the checks, orders the retry. */
function denialText(ruleName: string, checklist: string): string {
  return `Gate '${ruleName}' blocked this call. Before it can run, complete these checks:\n`
    + `${checklist}\n`
    + 'Perform the checks now, state their outcome in your reply, then retry this exact call.'
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
    return { name: rule.name, tools: (rule.tools ?? ['bash']).map(wildcardToRegExp), patterns, checklist: rule.checklist }
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
   * The guard: first matching rule denies with its checklist; everything else
   * returns `undefined` and the call proceeds untouched. Registration returns
   * a disposer, so the effect disposes with the plugin fiber.
   */
  const guard: ToolGuard = (execution: Readonly<ToolExecution>): string | undefined => {
    const command = commandText(execution)
    if (command === undefined) return undefined
    for (const rule of rules) {
      if (!rule.tools.some(pattern => pattern.test(execution.name))) continue
      if (!rule.patterns.some(pattern => pattern.test(command))) continue
      return denialText(rule.name, rule.checklist)
    }
    return undefined
  }

  ctx.effect(() => ctx.tools.guard(guard))
}
