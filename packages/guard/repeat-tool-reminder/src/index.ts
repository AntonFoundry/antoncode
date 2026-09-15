/**
 * Advisory per-agent repeat-call detector. It enriches post-execute decisions
 * with logged model context without vetoing or rewriting calls. Configuration
 * and chain semantics live in the package README; rationale lives in the
 * repeat-tool-reminder Agent Note.
 * @module @deepseek-ai/dsh-repeat-tool-reminder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'repeat-tool-reminder'

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: an empty
 * `thresholds` list, a non-integer, a value below 2, or a duplicate throws at
 * plugin load, never a silent fall-back). `include`/`exclude` entries are
 * `*`-wildcard predicates over tool names at call time, not references to
 * registry entries — a pattern matching no currently registered tool is valid
 * (`exclude: [mcp_*]` must stay legal in a deployment that loads no MCP tools).
 */
export interface Config {
  /** Consecutive-repeat counts that trigger a reminder (default `[3, 5, 8]`). */
  thresholds?: number[]

  /**
   * Consecutive failed calls to one tool that trigger the guessing advisory
   * (default `3`). The run counts failures regardless of argument variation:
   * distinct arguments mean the model is guessing, identical arguments mean it
   * is ignoring an error — both are intent it cannot resolve from what it sees.
   */
  failureThreshold?: number
  /** Tool-name patterns to track; empty means every tool is tracked. */
  include?: string[]
  /** Tool-name patterns transparent to the chain (neither count nor reset). */
  exclude?: string[]
  /**
   * Maximum characters of canonical arguments quoted in the DETAILED reminder
   * (default 500). Large payloads (a `write` body, a long command) would
   * otherwise ride into the next request unbounded — precisely in a loop
   * scenario; the cap bounds the reminder, never the detection (the chain key
   * always compares the FULL canonical string).
   */
  argumentsPreviewChars?: number
  /**
   * Complete alternation cycles that trigger the ping-pong advisory (default
   * 2). One cycle is two calls whose canonical keys strictly alternate
   * (A, B, A, B, …) — the edit ping-pong a consecutive-repeat counter can
   * never see, because every call differs from its predecessor. Default 2
   * means the advisory fires on the fourth alternating call.
   */
  cycleThreshold?: number
  /**
   * When the ping-pong advisory is ignored and the alternation continues,
   * BLOCK the next cycle call (default `true`) with feedback ordering the
   * model to stop retrying and change approach — the automatic escape when
   * advisory-only nudges are not enough.
   */
  escalateToBlock?: boolean
}

export const Config: z<Config> = z.object({
  thresholds: z.array(z.number()).default([3, 5, 8]),
  failureThreshold: z.number().default(3),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  argumentsPreviewChars: z.number().default(500),
  cycleThreshold: z.number().default(2),
  escalateToBlock: z.boolean().default(true),
})

/**
 * The `{kind:'plugin'}` source stamped on every reminder this guard injects —
 * the label is load-bearing (an unlabeled context would render as a user
 * prompt in derived history).
 */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'repeat-tool-reminder' }

/**
 * The gentle first-threshold reminder. Keyed to `thresholds[0]`, not a literal
 * count, so a custom first threshold keeps the gentle-then-detailed escalation.
 */
const GENTLE_REMINDER =
  'You are repeating the exact same tool call with identical arguments. '
  + 'Carefully analyze the previous result before calling again: if the task is '
  + 'not complete, try a different approach or different arguments instead of '
  + 'repeating the call.'

/** The detailed later-threshold reminder naming the tool, the run length, and the canonical arguments. */
function detailedReminder(toolName: string, count: number, canonicalArguments: string): string {
  return 'Repeated tool call detected:\n'
    + `- tool: ${toolName}\n`
    + `- consecutive_calls: ${count}\n`
    + `- arguments: ${canonicalArguments}\n`
    + 'The repeated calls are not making progress. Do not call this tool with '
    + 'these exact arguments again. Inspect the latest result and choose a '
    + 'different action, different arguments, or finish the task if enough '
    + 'evidence has been gathered.'
}

/**
 * The guessing advisory, delivered when one tool has failed `failureThreshold`
 * consecutive times. Names the tool and orders the three-step escape: read the
 * failure, discover the correct arguments, or ask the human.
 */
function guessingReminder(toolName: string, count: number): string {
  return `Repeated failures detected: the last ${count} calls to ${toolName} failed. Do not guess argument values again.
`
    + '- Re-read the failure messages: they usually name the exact invalid field or referent.\n'
    + '- Look for the discovery tool for this surface (a list, catalog, or inspect tool) and call it before retrying.\n'
    + '- If the correct arguments remain ambiguous or no listing exists, ask the user with ask_user_question instead of trying again.'
}

/**
 * The ping-pong advisory, delivered on the first complete alternation run.
 * Names the tool and the cycle length and orders a concrete escape: pick one
 * direction, apply it once, verify.
 */
function pingPongReminder(toolName: string, cycles: number): string {
  return `Loop detected: the last calls to ${toolName} have alternated between two argument sets ${cycles} times — each edit appears to undo the other, so no progress is possible.\n`
    + 'Stop making these calls. Re-read the current state of the target, decide which of the two changes is the one you actually want, apply it exactly once, and verify the result. '
    + 'If you cannot decide which direction is correct, stop and ask the user.'
}

/**
 * The ping-pong veto, delivered as a BLOCK when the advisory was ignored and
 * the alternation continued. The model sees this as the tool call's failure
 * and must choose a different action.
 */
function pingPongVeto(toolName: string, cycles: number): string {
  return `Call blocked: this ${toolName} call continues a detected ping-pong — the last ${cycles} alternations cycled between two argument sets without progress, and an advisory was already delivered.\n`
    + 'Do NOT retry this call or its inverse. Re-read the current state of the target, choose the single final change you want, apply it once, or stop and ask the user for guidance.'
}

/**
 * The length in entries of a complete cycle window: `cycleThreshold`
 * alternations need `2 * cycleThreshold` consecutive keys.
 */
function cycleWindow(cycleThreshold: number): number {
  return cycleThreshold * 2
}

/**
 * Whether the tail of `recent` forms a strict period-2 cycle of at least
 * `cycleThreshold` complete alternations (A, B, A, B, …). The last two keys
 * must differ — a constant run is the identical-repeat detector's domain.
 */
function detectCycle(recent: readonly string[], cycleThreshold: number): boolean {
  const window = cycleWindow(cycleThreshold)
  if (recent.length < window) return false
  const tail = recent.slice(-window)
  const half = window / 2
  for (let i = 0; i < half; i += 1) {
    if (tail[i] !== tail[i + half]) return false
  }
  return tail[half - 1] !== tail[half]
}

/**
 * Deep key-sort of a parsed-JSON value so two argument objects that differ
 * only in property order canonicalize identically. Arguments reach the guard
 * as the loop's `JSON.parse` output (or its raw-string fallback for malformed
 * argument JSON), so JSON's value domain is the whole input domain — no
 * bigint, cycle, or `undefined` handling exists because no input path can
 * produce them.
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key])
    }
    return sorted
  }
  return value
}

/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue))
}

/** Compile one `*`-wildcard pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Head-truncate the canonical arguments for quoting in the detailed reminder,
 * marking how much was omitted. Bounds only the model-visible text — the
 * chain key always uses the full canonical string.
 */
function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`
}

/**
 * Validate `thresholds` per the fail-loud contract and return them sorted
 * ascending (the escalation rule reads `thresholds[0]` as the gentle tier, so
 * order is normalized here, once).
 */
function validateThresholds(values: number[]): number[] {
  if (values.length === 0) {
    throw new Error('repeat-tool-reminder: `thresholds` must not be empty')
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(`repeat-tool-reminder: invalid threshold ${value} — every threshold must be an integer >= 2`)
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error('repeat-tool-reminder: `thresholds` must not contain duplicates')
  }
  return [...values].sort((a, b) => a - b)
}

/**
 * Prepend the guard's reminder while preserving every downstream context's
 * source and metadata.
 */
function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
  return [ours, ...theirs ?? []]
}

/**
 * One agent's repeat state: the consecutive-repeat chain (identity key + run
 * length) plus the recent-key ring that powers ping-pong detection and the
 * advisory-once-then-block escalation flag.
 */
interface Chain {
  key: string
  count: number
  /** Ring of the last tracked call keys, oldest first (ping-pong window). */
  recent: string[]
  /** A ping-pong advisory was delivered and the alternation has not broken since. */
  advisedCycle: boolean
  /** Consecutive failed-call run on one tool; `advised` is once per episode. */
  failures?: { tool: string; count: number; advised: boolean }
}

/** Ring cap: deep enough for a cycle window plus slack, small enough to stay trivial. */
const RECENT_CAP = 8

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; `thresholds` is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the fields are set after validation.
  const thresholds = validateThresholds(config.thresholds as number[])
  const thresholdSet = new Set(thresholds)
  const includePatterns = (config.include as string[]).map(wildcardToRegExp)
  const excludePatterns = (config.exclude as string[]).map(wildcardToRegExp)
  const argumentsPreviewChars = config.argumentsPreviewChars as number
  if (!Number.isInteger(argumentsPreviewChars) || argumentsPreviewChars < 1) {
    throw new Error(`repeat-tool-reminder: invalid argumentsPreviewChars ${argumentsPreviewChars} — must be an integer >= 1`)
  }
  const cycleThreshold = config.cycleThreshold as number
  if (!Number.isInteger(cycleThreshold) || cycleThreshold < 2) {
    throw new Error(`repeat-tool-reminder: invalid cycleThreshold ${cycleThreshold} — must be an integer >= 2`)
  }
  const escalateToBlock = config.escalateToBlock as boolean
  const failureThreshold = config.failureThreshold as number
  if (!Number.isInteger(failureThreshold) || failureThreshold < 2) {
    throw new Error(`repeat-tool-reminder: invalid failureThreshold ${failureThreshold} — must be an integer >= 2`)
  }

  const chains = new WeakMap<Agent, Chain>()

  /** Whether a tool participates in the chain (untracked calls are transparent: they neither count nor reset). */
  function tracked(toolName: string): boolean {
    if (includePatterns.length > 0 && !includePatterns.some(pattern => pattern.test(toolName))) return false
    return !excludePatterns.some(pattern => pattern.test(toolName))
  }

  /**
   * Advance the calling agent's chain for one attempt and return the reminder
   * to deliver, if this attempt's run length hits a configured threshold.
   * Counting happens here — in post-execute — because denied calls also flow
   * through this waterfall (`ToolRuntime.execute` routes a deny through the
   * same pipeline), and a model hammering a denied call is exactly the loop
   * worth breaking.
   */
  function observe(exec: ToolExecution, failed: boolean): { context?: UserMessage; veto?: UserMessage } | undefined {
    // A direct `ctx.tools.execute()` caller has no model to remind and no id
    // to key on; only agent-loop calls participate.
    if (!exec.agent) return undefined
    if (!tracked(exec.name)) return undefined
    const canonical = canonicalize(exec.arguments)
    const key = JSON.stringify([exec.name, canonical])
    const chain = chains.get(exec.agent)
    const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1
    const recent = [...(chain?.recent ?? []), key].slice(-RECENT_CAP)
    const wasAdvised = chain?.advisedCycle ?? false
    const cycling = detectCycle(recent, cycleThreshold)
    // The advisory is once per episode: a broken alternation (a new distinct
    // key) re-arms it, a continuing alternation escalates past it. The flag
    // flips to true WHEN the advisory fires (below), not before.
    let advisedCycle = cycling ? wasAdvised : false

    // Escalation first: an ignored advisory means the nudge failed — the
    // automatic escape is refusing the call outright.
    let outcome: { context?: UserMessage; veto?: UserMessage } | undefined
    if (cycling && escalateToBlock && wasAdvised) {
      outcome = { veto: createUserMessage({
        content: [{ type: 'text', text: pingPongVeto(exec.name, cycleThreshold) }],
        source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${exec.name} ping-pong veto` },
      }) }
    } else if (cycling && !wasAdvised) {
      advisedCycle = true
      outcome = { context: createUserMessage({
        content: [{ type: 'text', text: pingPongReminder(exec.name, cycleThreshold) }],
        source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${exec.name} ping-pong × ${cycleThreshold}` },
      }) }
    } else if (thresholdSet.has(count)) {
      const text = count === thresholds[0]
        ? GENTLE_REMINDER
        : detailedReminder(exec.name, count, previewArguments(canonical, argumentsPreviewChars))
      outcome = { context: createUserMessage({
        content: [{ type: 'text', text }],
        source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${exec.name} × ${count}` },
      }) }
    }
    // Failure-run tracking: a success breaks the run; a failure on another tool
    // restarts it; the advisory fires once per episode at the threshold.
    let failures = chain?.failures
    let failureContext: UserMessage | undefined
    if (!failed) failures = undefined
    else {
      const run = failures !== undefined && failures.tool === exec.name
        ? { tool: exec.name, count: failures.count + 1, advised: failures.advised }
        : { tool: exec.name, count: 1, advised: false }
      if (run.count === failureThreshold && !run.advised) {
        run.advised = true
        failureContext = createUserMessage({
          content: [{ type: 'text', text: guessingReminder(exec.name, run.count) }],
          source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${exec.name} failed × ${run.count}` },
        })
      }
      failures = run
      if (failureContext !== undefined) {
        outcome = { context: failureContext, ...outcome?.veto !== undefined ? { veto: outcome.veto } : {} }
      }
    }
    chains.set(exec.agent, { key, count, recent, advisedCycle, ...failures === undefined ? {} : { failures } })
    // The veto THROWS rather than returning a block decision: execute's outer
    // try/catch converts the throw into an isError result whose message is the
    // veto text — the guaranteed escape surface (a returned block decision can
    // be overridden elsewhere in the waterfall composition).
    if (outcome?.veto !== undefined) {
      throw new Error(outcome.veto.content.map(b => b.type === 'text' ? b.text ?? '' : '').join(''))
    }
    return outcome
  }

  // Observe-and-enrich, never veto: count first (state advances regardless of
  // the downstream outcome), DELEGATE so a later listener can still block or
  // replace, then fold the reminder onto whatever came back — additionalContexts
  // rides both decision variants, so a blocked call still gets the nudge.
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const outcome = observe(exec, result.isError === true)
    const downstream = await next()
    if (outcome === undefined) return downstream
    if (outcome.veto !== undefined) {
      // The escape: refuse the call with the veto as feedback. A downstream
      // block keeps its own feedback; ours rides the additional contexts.
      const contexts = prependContext(outcome.veto, downstream.additionalContexts)
      if (downstream.kind === 'block') {
        return { kind: 'block', feedback: downstream.feedback, additionalContexts: contexts }
      }
      return {
        kind: 'block',
        feedback: outcome.veto.content,
        additionalContexts: contexts,
      }
    }
    if (outcome.context === undefined) return downstream
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: prependContext(outcome.context, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(outcome.context, downstream.additionalContexts),
    }
  })

  // A user interjection changes the context; repetition across it is not a
  // loop. Pure reset hook: always delegates (attaching nothing, vetoing
  // nothing).
  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) chains.delete(agent)
    return next()
  })
}
