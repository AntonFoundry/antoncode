import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AgentMailConversationView } from './AgentMailConversationView.tsx'
import { en, zh, type AgentMailLocaleKey } from './locales.ts'

export type { AgentMailConversationViewProps } from './AgentMailConversationView.tsx'
export type { AgentMailLocaleKey } from './locales.ts'

const NS = 'conversation.agentMail'

/** Required services: conversation view-slot registration and localized copy; no queue/API dependency. */
export const inject = ['slots', 'locale']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'conversation.agentMail': AgentMailLocaleKey
  }
}

/** Register a read-only Agent Mail conversation view; no inbox or messaging RPC is invoked. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-conversation-agent-mail: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'agent-mail',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: (_sessionId: import('@deepseek-ai/dsh-client-runtime/client').SessionId) => ({}),
  }, AgentMailConversationView))
}
