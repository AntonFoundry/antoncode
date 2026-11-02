/**
 * Browser Workflows-tab plugin: registers the `dagflow` entry of the
 * conversation view slot (header [ Orchestrator | Workflows | Chat ]) with the
 * LangFlow embed, driven by the `langflow.*` wire domain through the
 * connection's typed API client.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LangflowView } from './langflow.tsx'
import type { LangflowActions } from './langflow.tsx'
import { NS, en, zh } from './locales.ts'

/** Required services: the conversation slot, the locale service, and the connection carrying the API client. */
export const inject = ['slots', 'locale', 'remote', 'remote.langflow']

/**
 * Client plugin body: register the Workflows tab. The langflow.* actions
 * close over the connection's typed API client; the embed is a pure
 * projection of the sidecar's lifecycle status.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-flowbuilder: dictionaries')
  const t = ctx.locale.bind(NS)
  const unwrap = async <T>(call: Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>): Promise<T> => {
    const result = await call
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  const actions: LangflowActions = {
    status: () => unwrap(ctx.remote.langflow.status()),
    start: () => unwrap(ctx.remote.langflow.start()),
    stop: () => unwrap(ctx.remote.langflow.stop()),
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'dagflow',
    order: 6,
    locale: NS,
    label: () => t('view.dagflow'),
    inject: (_sessionId: SessionId) => ({ labels: { t }, actions }),
  }, LangflowView))
}
