/**
 * Per-session Agent Mail channel selection shared by the view (which renders
 * the active channel) and the resident composer route (which sends to it).
 * Browser state only: the channel is presentation, the Host still authorizes
 * every send.
 */

/** Channel the resident composer currently addresses. */
export type AgentMailChannel = 'local' | 'direct'

const channels = new Map<string, AgentMailChannel>()
const listeners = new Map<string, Set<() => void>>()

/**
 * Active Agent Mail channel for one agent session.
 * @param sessionId - agent session whose channel is read.
 * @returns the selected channel, defaulting to the workspace channel.
 */
export function agentMailChannel(sessionId: string): AgentMailChannel {
  return channels.get(sessionId) ?? 'local'
}

/**
 * Switch one session's channel.
 * @param sessionId - agent session whose channel changes.
 * @param channel - channel the next composer submission addresses.
 */
export function setAgentMailChannel(sessionId: string, channel: AgentMailChannel): void {
  if (agentMailChannel(sessionId) === channel) return
  channels.set(sessionId, channel)
  for (const listener of listeners.get(sessionId) ?? []) listener()
}

/**
 * Subscribe to channel changes for one session.
 * @param sessionId - agent session observed.
 * @param listener - change callback.
 * @returns unsubscribe.
 */
export function subscribeAgentMailChannel(sessionId: string, listener: () => void): () => void {
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
