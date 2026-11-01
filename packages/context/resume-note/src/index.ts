/**
 * Opt-in resume note for crash-interrupted turns. When the durable session
 * log's last `turn/end` carries `reason.kind === 'interrupted'` — the marker
 * the persistence repair commits for a crash-orphaned tail turn — the first
 * step of the next turn appends one durable, source-attributed notice so the
 * model knows the transcript gap is a harness restart, not user intent.
 *
 * @module @deepseek-ai/dsh-resume-note
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The notice this plugin appends after a crash-interrupted tail turn. */
    'resume-note': { kind: 'resume-note' } & ContextFormed
  }
}

/** Cordis plugin name used by loader diagnostics and log-source attribution. */
export const name = 'resume-note'

/** The agent registry that owns pre-step processing. */
export const inject = ['agents']

/** Default model-visible note text; pinned by snapshots. */
export const DEFAULT_NOTE_TEXT = '[harness] The previous turn was interrupted by a harness restart before it completed. Treat the user\'s next message as resume: continue the standing work from where the transcript stops, without re-asking what was interrupted.'

/** Resume-note injection scheduling. Invalid values fail plugin load. */
export interface Config {
  /** Set `false` to suppress injection without removing the plugin row. Default `true`. */
  enabled?: boolean
  /** Override the model-visible note text. Omit for {@link DEFAULT_NOTE_TEXT}. */
  text?: string
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean(),
  text: z.string(),
})

/**
 * Whether the session's tail calls for a resume note: the last `turn/end`
 * is interrupted and no resume note follows it. A backward scan settles
 * both in one pass — events between the last `turn/end` and the open step
 * are exactly the resume window the note may occupy.
 * @param events - the durable session log to scan.
 * @returns true when a note should be appended at the open step.
 */
export function tailNeedsResumeNote(events: readonly SessionEvent[]): boolean {
  for (const event of [...events].reverse()) {
    if (event.type === 'user/message' && event.data.source.kind === 'resume-note') return false
    if (event.type === 'turn/end') return event.data.reason.kind === 'interrupted'
  }
  return false
}

/**
 * Register a prepended pre-step listener for the lifetime of `ctx`.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - enable flag and note-text override.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return
  const text = config.text ?? DEFAULT_NOTE_TEXT
  ctx.on('agent/pre-step', async (
    { agent, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted) return decision
    // Only the first step of the turn carries the note: that is the resume
    // point after a repaired tail, and later steps of the same turn cannot
    // follow an interrupted `turn/end` without step 1 having passed.
    if (step !== 1) return decision
    if (!tailNeedsResumeNote(agent.session.snapshotEvents())) return decision
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: 'resume-note',
            form: 'notice',
            summary: 'previous turn was interrupted by a harness restart',
          },
        }),
      ],
    }
  }, { prepend: true })
}
