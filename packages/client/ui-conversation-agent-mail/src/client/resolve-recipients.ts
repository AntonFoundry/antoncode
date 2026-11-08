/** Resolve explicit picker addresses and mention shortcuts without changing delivery scope. */
import type { AgentMailComposerState } from './composer-targets.ts'
import type { AgentMailPeer } from './gateway.ts'
import { agentMentionToken, resolveMentions } from './mentions.ts'

/** A refused submission leaves the draft intact and performs no queue operation. */
export type RecipientFailure = 'staleRecipient' | 'wrongChannel' | 'recipientConflict' | 'mentionRequired'

/** Exact current recipients or the existing local broadcast mode. */
export type RecipientResolution =
  | { readonly ok: true; readonly channel: 'local' | 'direct'; readonly recipients: readonly AgentMailPeer[]; readonly workspaceWide: boolean }
  | { readonly ok: false; readonly reason: RecipientFailure }

/**
 * Resolve the current submission against the latest owner-authorized discovery.
 * @param selection - Fresh registered Session-store snapshot, not a captured render value.
 * @param peers - Current live peer discovery.
 * @param sender - Exact sending Session and currently authorized workspace.
 * @param text - Submitted body; target selection never rewrites it.
 * @returns One transport's exact current recipients, or a localized refusal key.
 */
export function resolveMailRecipients(
  selection: AgentMailComposerState,
  peers: readonly AgentMailPeer[],
  sender: { readonly sessionId: string; readonly workspaceId: string },
  text: string,
): RecipientResolution {
  const currentPeers = peers.filter(peer => peer.sessionId !== sender.sessionId)
  const mentions = resolveMentions(text, currentPeers)
  const knownTokens = new Set(currentPeers.map(peer => agentMentionToken(peer.sessionId)))
  // This grammar is specific to generated Agent mentions, not ordinary email or @ prose.
  const tokens = [...text.matchAll(/@([\p{L}\p{N}_-]+ [\p{L}\p{N}_-]+#[a-f0-9]{6})(?![a-f0-9])/gu)]
  if (tokens.some(token => !knownTokens.has(token[0].slice(1)))) return { ok: false, reason: 'staleRecipient' }
  const explicit = selection.recipients
  if (explicit.length > 0 && mentions.some(sessionId => !explicit.some(peer => peer.sessionId === sessionId))) {
    return { ok: false, reason: 'recipientConflict' }
  }
  const requested = explicit.length > 0 ? explicit : currentPeers.filter(peer => mentions.includes(peer.sessionId))
  const resolved: AgentMailPeer[] = []
  for (const recipient of requested) {
    const current = currentPeers.find(peer => peer.sessionId === recipient.sessionId
      && peer.workspaceId === recipient.workspaceId && peer.transport === recipient.transport)
    if (current === undefined) return { ok: false, reason: 'staleRecipient' }
    const channel = current.workspaceId === sender.workspaceId ? 'local' : 'direct'
    if (channel !== selection.channel || current.transport !== (channel === 'local' ? 'workspace-queue' : 'direct')) {
      return { ok: false, reason: 'wrongChannel' }
    }
    if (!resolved.some(peer => peer.sessionId === current.sessionId)) resolved.push(current)
  }
  if (selection.channel === 'direct' && resolved.length === 0) return { ok: false, reason: 'mentionRequired' }
  return { ok: true, channel: selection.channel, recipients: resolved, workspaceWide: resolved.length === 0 }
}
