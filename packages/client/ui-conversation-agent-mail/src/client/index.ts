import type { Context } from '@deepseek-ai/cordis'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AgentMailConversationView } from './AgentMailConversationView.tsx'
import { createAgentMailGateway } from './api-gateway.ts'
import type { AgentMailGateway } from './gateway.ts'
import { en, zh, type AgentMailLocaleKey } from './locales.ts'

export type { AgentMailConversationViewProps } from './AgentMailConversationView.tsx'
export type { AgentMailLocaleKey } from './locales.ts'
export type { AgentMailGateway } from './gateway.ts'
export { createAgentMailGateway } from './api-gateway.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional Host-authorized browser capability. Its absence keeps Agent Mail read-only. */
    agentMailGateway: AgentMailGateway
  }
}

const NS = 'conversation.agentMail'

/** Required services: conversation view slot and localized copy. Connection is optional and fails closed. */
export const inject = ['slots', 'locale']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'conversation.agentMail': AgentMailLocaleKey
  }
}

/** Register Agent Mail with an optional typed, scoped Host RPC gateway. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-conversation-agent-mail: dictionaries')
  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection') as { api?: IApiClient } | undefined
  const api = connection?.api
  const gateway = api?.agentMail ? createAgentMailGateway(api) : undefined
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'agent-mail',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: (_sessionId: import('@deepseek-ai/dsh-client-runtime/client').SessionId) => {
      const provider = ctx.get('agentMailGateway') ?? gateway
      return provider === undefined ? {} : { gateway: provider }
    },
  }, AgentMailConversationView))
}
