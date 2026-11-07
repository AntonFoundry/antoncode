import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ClientSessionContext, InputTriggerServiceContract, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { AgentMailConversationView } from './AgentMailConversationView.tsx'
import { createAgentMailGateway } from './api-gateway.ts'
import { agentDisplayName } from './agent-names.ts'
import { agentMailChannel } from './composer-targets.ts'
import type { AgentMailGateway } from './gateway.ts'
import { agentMentionToken, peersForChannel, resolveMentions } from './mentions.ts'
import { registerAgentMailRelays } from './relay-projection.ts'
import { en, zh, type AgentMailLocaleKey } from './locales.ts'

export type { AgentMailConversationViewProps } from './AgentMailConversationView.tsx'
export type { AgentMailLocaleKey } from './locales.ts'
export type { AgentMailGateway } from './gateway.ts'
export { createAgentMailGateway } from './api-gateway.ts'
export { agentMentionToken, resolveMentions } from './mentions.ts'
export { agentMailChannel, setAgentMailChannel, subscribeAgentMailChannel } from './composer-targets.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional override of the browser Agent Mail gateway. */
    agentMailGateway: AgentMailGateway
  }
}

const NS = 'conversation.agentMail'

/** Required services: conversation view slot, composer routing, `@` source, and localized copy. */
export const inject = ['slots', 'locale', 'conversation', 'uiConversation', 'inputTriggers', 'remote', 'remote.agentMail']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'conversation.agentMail': AgentMailLocaleKey
  }
}

/** Register Agent Mail with the owner-only Host Remote gateway. */
export function apply(ctx: Context): void {
  registerAgentMailRelays(ctx)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-conversation-agent-mail: dictionaries')
  const t = ctx.locale.bind(NS)
  const gateway = createAgentMailGateway(ctx.remote.agentMail)
  if (gateway !== undefined) registerComposerRoute(ctx, gateway, t)
  registerMentionSource(ctx, gateway)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'agent-mail',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: (_sessionId: SessionId) => {
      const provider = ctx.get('agentMailGateway') ?? gateway
      return provider === undefined ? {} : { gateway: provider }
    },
  }, AgentMailConversationView))
}

/**
 * The resident composer becomes the Agent Mail composer while this view is
 * active. Mentions choose recipients; a local message without one is the
 * workspace broadcast.
 * @param ctx - plugin context carrying the conversation service.
 * @param gateway - authorized Agent Mail RPC face.
 * @param t - Agent Mail copy.
 */
function registerComposerRoute(
  ctx: Context,
  gateway: AgentMailGateway,
  t: TranslateNS<'conversation.agentMail'>,
): void {
  ctx.effect(() => ctx.conversation.composerRoutes.register('agent-mail', {
    async submit({ sessionId, text, imageIds }) {
      if (imageIds.length > 0) throw new Error(t('imagesUnsupported'))
      const body = text.trim()
      if (body === '') return
      const auth = gateway.authorization(sessionId)
      if (auth.state !== 'authorized' || auth.workspaceId === undefined) throw new Error(t('connecting'))
      const channel = agentMailChannel(sessionId)
      const peers = gateway.peers(sessionId).filter(peer => peer.sessionId !== sessionId)
      const mentions = resolveMentions(body, peers)
      const compatible = new Set(peersForChannel(peers, sessionId, auth.workspaceId, channel).map(peer => peer.sessionId))
      if (mentions.some(recipient => !compatible.has(recipient))) throw new Error(t('wrongChannel'))
      if (channel === 'direct') {
        if (mentions.length === 0) throw new Error(t('mentionRequired'))
        await gateway.sendDirect({ sessionId, workspaceId: auth.workspaceId, recipients: mentions, body })
        return
      }
      if (mentions.length > 0) {
        await gateway.sendLocal({
          sessionId, workspaceId: auth.workspaceId, recipients: mentions, body, workspaceWide: false,
        })
        return
      }
      await gateway.sendLocal({
        sessionId, workspaceId: auth.workspaceId, recipients: [], body, workspaceWide: true,
      })
    },
  }), 'ui-conversation-agent-mail: composer route')
}

/**
 * Register the `@` source that suggests agent display names while Agent Mail
 * is the active view. The token carries the deterministic tag, never a
 * session id, so two agents with the same name stay distinguishable.
 * @param ctx - plugin context carrying the input trigger service.
 * @param gateway - authorized Agent Mail RPC face; absent keeps the source inert.
 */
function registerMentionSource(ctx: Context, gateway: AgentMailGateway | undefined): void {
  const triggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const roster = (session: ClientSessionContext): readonly { sessionId: string; workspaceId: string }[] => {
    if (gateway === undefined) return []
    const sessionId = session.sessionId
    const workspaceId = gateway.authorization(sessionId).workspaceId
    if (workspaceId === undefined) return []
    return peersForChannel(gateway.peers(sessionId), sessionId, workspaceId, agentMailChannel(sessionId))
  }
  const active = (session: ClientSessionContext): boolean =>
    ctx.conversation.activeView(session.sessionId) === 'agent-mail'
  const source: InputTriggerSource = {
    trigger: '@',
    name: 'agent-mail',
    order: 5,
    candidates(session, { query }) {
      if (!active(session)) return Promise.resolve([])
      const needle = query.toLowerCase()
      return Promise.resolve(roster(session)
        .filter(peer => agentMentionToken(peer.sessionId).toLowerCase().includes(needle))
        .map(peer => ({
          name: agentMentionToken(peer.sessionId),
          description: peer.workspaceId,
          hint: `@${agentDisplayName(peer.sessionId)}`,
        })))
    },
    lexicon(session) {
      return active(session) ? roster(session).map(peer => agentMentionToken(peer.sessionId)) : []
    },
    subscribeLexicon(session, listener) {
      if (gateway === undefined || !active(session)) return () => {}
      return gateway.subscribeInbox(listener)
    },
    onPick({ candidate }) {
      return { text: `@${candidate.name} ` }
    },
    codec: {
      clipboardText: ref => `@${ref}`,
      serialize: ref => Promise.resolve(`@${ref}`),
    },
  }
  ctx.effect(() => triggers.registerSource(source), 'ui-conversation-agent-mail: @ source')
}
