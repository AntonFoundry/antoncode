/**
 * Agent mention tokens. A token is the deterministic display name plus its
 * six-hex discriminator, so two agents that collide by name remain separately
 * addressable without exposing a session id in the draft.
 */
import { agentDisplayName, agentNameTag } from './agent-names.ts'

/** One addressable peer as the mention pipeline sees it. */
export interface MentionPeer {
  readonly sessionId: string
  readonly workspaceId: string
}

/**
 * Token inserted by the `@` menu and recognized on submit.
 * @param sessionId - durable session id the token resolves to.
 * @returns `Name#tag`.
 */
export function agentMentionToken(sessionId: string): string {
  return `${agentDisplayName(sessionId)}#${agentNameTag(sessionId)}`
}

/**
 * Resolve the peers named by `@` tokens in one draft. Longest tokens win so a
 * bare display name cannot shadow a tag-qualified one.
 * @param text - composer draft.
 * @param peers - addressable roster from the Host.
 * @returns unique named session ids in first-mention order.
 */
export function resolveMentions(text: string, peers: readonly MentionPeer[]): readonly string[] {
  const matches: Array<{ start: number; sessionId: string }> = []
  for (const peer of peers) {
    const needle = `@${agentMentionToken(peer.sessionId)}`
    let from = 0
    for (;;) {
      const at = text.indexOf(needle, from)
      if (at < 0) break
      matches.push({ start: at, sessionId: peer.sessionId })
      from = at + needle.length
    }
  }
  matches.sort((left, right) => left.start - right.start)
  const found: string[] = []
  for (const match of matches) {
    if (!found.includes(match.sessionId)) found.push(match.sessionId)
  }
  return found
}
