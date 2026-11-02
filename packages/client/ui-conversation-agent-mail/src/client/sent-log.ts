/**
 * Optimistic Agent Mail outbox. The Host queue only returns messages addressed
 * to the reading session, so a message this agent sent to a peer would vanish
 * from its own feed until a reply arrives. The view merges this short-lived
 * record so the channel reads like a conversation.
 */
import type { AgentMailChannel } from './composer-targets.ts'

/** One message this browser session sent successfully. */
export interface AgentMailSentEntry {
  readonly key: string
  readonly channel: AgentMailChannel
  readonly from: string
  readonly to: readonly string[]
  readonly body: string
  readonly at: number
}

const entries = new Map<string, AgentMailSentEntry[]>()
const listeners = new Map<string, Set<() => void>>()
const EMPTY: readonly AgentMailSentEntry[] = []

let nextKey = 0

/**
 * Record one successful send for immediate display.
 * @param sessionId - sending agent session.
 * @param channel - channel the message was delivered on.
 * @param from - sender session id.
 * @param to - addressed session ids; empty is the workspace broadcast.
 * @param body - message text.
 */
export function recordAgentMailSent(
  sessionId: string,
  channel: AgentMailChannel,
  from: string,
  to: readonly string[],
  body: string,
): void {
  nextKey += 1
  const list = entries.get(sessionId) ?? []
  entries.set(sessionId, [...list, {
    key: `sent:${nextKey}`, channel, from, to, body, at: Date.now(),
  }])
  for (const listener of listeners.get(sessionId) ?? []) listener()
}

/**
 * Recorded sends for one session.
 * @param sessionId - sending agent session.
 * @returns the sent entries in send order.
 */
export function agentMailSent(sessionId: string): readonly AgentMailSentEntry[] {
  return entries.get(sessionId) ?? EMPTY
}

/**
 * Subscribe to sent-entry changes for one session.
 * @param sessionId - observed agent session.
 * @param listener - change callback.
 * @returns unsubscribe.
 */
export function subscribeAgentMailSent(sessionId: string, listener: () => void): () => void {
  let sessionListeners = listeners.get(sessionId)
  if (sessionListeners === undefined) {
    sessionListeners = new Set()
    listeners.set(sessionId, sessionListeners)
  }
  sessionListeners.add(listener)
  return () => {
    sessionListeners.delete(listener)
    if (sessionListeners.size === 0) listeners.delete(sessionId)
  }
}
