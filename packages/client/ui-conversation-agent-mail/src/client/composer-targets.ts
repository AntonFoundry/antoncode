/** Session-scoped Agent Mail viewing and recipient choices, shared with its composer route. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { AgentMailPeer } from './gateway.ts'

/** Queue channel selected for the resident composer and mailbox view. */
export type AgentMailChannel = 'local' | 'direct'

/** Interaction state only; live eligibility remains owned by the mailbox resource. */
export interface AgentMailComposerState {
  channel: AgentMailChannel
  workspaceId: string | null
  recipients: AgentMailPeer[]
}

type AgentMailComposerActions = {
  setChannel: (draft: AgentMailComposerState, channel: AgentMailChannel) => void
  setWorkspace: (draft: AgentMailComposerState, workspaceId: string | null) => void
  replaceRecipients: (draft: AgentMailComposerState, recipients: readonly AgentMailPeer[]) => void
  removeRecipient: (draft: AgentMailComposerState, sessionId: string) => void
  clearRecipients: (draft: AgentMailComposerState) => void
}

/**
 * Declare one shared interaction store; the renderer owns each Session instance.
 * @returns The handle registered by the view and read fresh by composer commands.
 */
export function createAgentMailComposerStore(): EngineStoreHandle<AgentMailComposerState, AgentMailComposerActions> {
  return defineStore({
    init: (): AgentMailComposerState => ({ channel: 'local', workspaceId: null, recipients: [] }),
    actions: {
      setChannel: (draft, channel: AgentMailChannel) => {
        draft.channel = channel
        draft.workspaceId = null
        draft.recipients = []
      },
      setWorkspace: (draft, workspaceId: string | null) => { draft.workspaceId = workspaceId },
      replaceRecipients: (draft, recipients: readonly AgentMailPeer[]) => {
        draft.recipients = [...recipients]
        const first = recipients[0]
        if (first !== undefined) {
          draft.channel = first.transport === 'direct' ? 'direct' : 'local'
          draft.workspaceId = first.workspaceId
        }
      },
      removeRecipient: (draft, sessionId: string) => {
        draft.recipients = draft.recipients.filter(recipient => recipient.sessionId !== sessionId)
      },
      clearRecipients: (draft) => { draft.recipients = [] },
    },
  })
}
