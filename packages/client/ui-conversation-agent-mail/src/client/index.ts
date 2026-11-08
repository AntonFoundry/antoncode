import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ClientSessionContext, InputTriggerServiceContract, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { AgentMailConversationView } from './AgentMailConversationView.tsx'
import { createAgentMailGateway } from './api-gateway.ts'
import { agentDisplayName } from './agent-names.ts'
import { createAgentMailComposerStore, type AgentMailComposerState } from './composer-targets.ts'
import { createAgentMailResourceProvider } from './mail-resource.ts'
import { resolveMailRecipients } from './resolve-recipients.ts'
import type { AgentMailGateway } from './gateway.ts'
import { agentMentionToken, peersForChannel } from './mentions.ts'
import { registerAgentMailRelays } from './relay-projection.ts'
import { en, zh, type AgentMailLocaleKey } from './locales.ts'

export type { AgentMailConversationViewProps } from './AgentMailConversationView.tsx'
export type { AgentMailLocaleKey } from './locales.ts'
export type { AgentMailGateway } from './gateway.ts'
export { createAgentMailGateway } from './api-gateway.ts'
export { agentMentionToken, resolveMentions } from './mentions.ts'
export { createAgentMailComposerStore } from './composer-targets.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional override of the browser Agent Mail gateway. */
    agentMailGateway: AgentMailGateway
  }
}

const NS = 'conversation.agentMail'

/** Required services: conversation view slot, composer routing, `@` source, and localized copy. */
export const inject = ['slots', 'locale', 'conversation', 'uiConversation', 'inputTriggers', 'sessions', 'resources', 'remote', 'remote.agentMail']

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
  const gateway = ctx.get('agentMailGateway') ?? createAgentMailGateway(ctx.remote.agentMail)
  const composerStore = createAgentMailComposerStore()
  const selection = (sessionId: SessionId): AgentMailComposerState => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error(t('connecting'))
    return ctx.slots.getStoreSnapshot(composerStore, { key: sessionId, ctx: binding.ctx })
  }
  ctx.effect(() => () => gateway.dispose(), 'ui-conversation-agent-mail: gateway')
  ctx.effect(() => ctx.resources.register(createAgentMailResourceProvider(gateway, ctx.remote)), 'ui-conversation-agent-mail: resource')
  registerComposerRoute(ctx, gateway, selection, t)
  registerMentionSource(ctx, gateway, selection)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'agent-mail',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    store: composerStore,
    inject: (sessionId: SessionId) => ({
      refreshMail: () => gateway.refresh(sessionId),
      acknowledgeMail: async (channel: 'local' | 'direct', throughSeq: number) => {
        const workspaceId = gateway.authorization(sessionId).workspaceId
        if (workspaceId === undefined) throw new Error(t('connecting'))
        await gateway.acknowledge({ sessionId, workspaceId, channel, throughSeq })
      },
      focusComposer: () => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding !== undefined) ctx.conversation.input.for(binding.ctx).focus()
      },
    }),
  }, AgentMailConversationView))
}

/**
 * The resident composer becomes the Agent Mail composer while this view is
 * active. Mentions choose recipients; a local message without one is the
 * workspace broadcast.
 * @param ctx - plugin context carrying the conversation service.
 * @param gateway - authorized Agent Mail RPC face.
 * @param selection - Read the registered current Session's interaction snapshot at submission.
 * @param t - Agent Mail copy.
 */
function registerComposerRoute(
  ctx: Context,
  gateway: AgentMailGateway,
  selection: (sessionId: SessionId) => AgentMailComposerState,
  t: TranslateNS<'conversation.agentMail'>,
): void {
  ctx.effect(() => ctx.conversation.composerRoutes.register('agent-mail', {
    async submit({ sessionId, text, imageIds }) {
      if (imageIds.length > 0) throw new Error(t('imagesUnsupported'))
      const body = text.trim()
      if (body === '') return
      const auth = gateway.authorization(sessionId)
      if (auth.state !== 'authorized' || auth.workspaceId === undefined) throw new Error(t('connecting'))
      const resolved = resolveMailRecipients(selection(sessionId), gateway.peers(sessionId), {
        sessionId, workspaceId: auth.workspaceId,
      }, body)
      if (!resolved.ok) throw new Error(t(resolved.reason))
      const recipients = resolved.recipients.map(peer => peer.sessionId)
      if (resolved.channel === 'direct') {
        await gateway.sendDirect({ sessionId, workspaceId: auth.workspaceId, recipients, body })
      } else {
        await gateway.sendLocal({ sessionId, workspaceId: auth.workspaceId, recipients, body, workspaceWide: resolved.workspaceWide })
      }
    },
  }), 'ui-conversation-agent-mail: composer route')
}

/**
 * Register the `@` source that suggests agent display names while Agent Mail
 * is the active view. The token carries the deterministic tag, never a
 * session id, so two agents with the same name stay distinguishable.
 * @param ctx - plugin context carrying the input trigger service.
 * @param gateway - Authorized Mail state shared with the resource provider.
 * @param selection - Read the current registered Session-store channel for each lookup.
 */
function registerMentionSource(
  ctx: Context, gateway: AgentMailGateway, selection: (sessionId: SessionId) => AgentMailComposerState,
): void {
  const triggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const roster = (session: ClientSessionContext): readonly { sessionId: string; workspaceId: string }[] => {
    const sessionId = session.sessionId
    const workspaceId = gateway.authorization(sessionId).workspaceId
    if (workspaceId === undefined) return []
    return peersForChannel(gateway.peers(sessionId), sessionId, workspaceId, selection(sessionId).channel)
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
      if (!active(session)) return () => {}
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
