/** Package-owned resume-note invariants. @module @deepseek-ai/dsh-resume-note/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'resume-note-invariant'

/** The invariant service this companion registers into. */
export const inject = ['invariants']

const PACKAGE_NAME = '@deepseek-ai/dsh-resume-note'
const SOURCE_NAME = 'resume-note'

/** True for this package's own injected messages. */
function isResumeNote(event: SessionEvent): boolean {
  return event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === SOURCE_NAME
}

/**
 * Validate one resume note against the log that precedes it: the nearest
 * earlier `turn/end` must be interrupted, and no earlier note may sit
 * between that end and this note (the once-only relation).
 */
function validateNote(preceding: readonly SessionEvent[], fail: InvariantFailure): void {
  for (const event of [...preceding].reverse()) {
    if (isResumeNote(event)) {
      fail('resume-note must be appended at most once per interrupted turn/end')
    }
    if (event.type === 'turn/end') {
      if (event.data.reason.kind !== 'interrupted') {
        fail('resume-note requires a preceding interrupted turn/end')
      }
      return
    }
  }
  fail('resume-note requires a preceding interrupted turn/end')
}

/** Validate all package-owned notes already present in one session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const [index, event] of session.events.entries()) {
    if (!isResumeNote(event)) continue
    validateNote(session.events.slice(0, index), fail)
  }
}

/** Install validation for loaded and newly appended resume notes. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!isResumeNote(event)) return
    validateNote(session.events, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the resume-note invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
