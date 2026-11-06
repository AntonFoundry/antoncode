/** Browser conversation view over the Session and Workspace Controller sources. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CancellationNotice } from './notice.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { RunAction } from './contract.ts'
import { NS, en, zh } from './locales.ts'
import { OrchestratorView } from './views.tsx'

/** Services consumed by the board and its cancellation callback. */
export const inject = ['slots', 'locale', 'sessions', 'workspaces']

/**
 * Register the board with framework-bound source hooks and owned Session actions.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-orchestrator: dictionaries')
  const t = ctx.locale.bind(NS)
  const notice = createSnapshotStore<{ text: string; tone: 'success' | 'error' } | null>(null)
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() }, 'ui-orchestrator: operations')
  const onAct = (sessionId: string, _action: RunAction): void => {
    const id = sessionId as SessionId
    void ctx.sessions.using(ctx.sessions.subagentAddress(id) ?? id, {
      source: 'controllerOperation', signal: lifetime.signal,
    }, async (reference) => {
      lifetime.signal.throwIfAborted()
      const result = await reference.binding.session.cancel()
      if (!result.ok) {
        notice.set({ text: `${t('cancel.failed')} ${result.error.message}`, tone: 'error' })
        return
      }
      notice.set({ text: t('cancel.accepted'), tone: 'success' })
    }).catch((error: unknown) => {
      notice.set({ text: `${t('cancel.failed')} ${error instanceof Error ? error.message : String(error)}`, tone: 'error' })
    })
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'orchestrator-cancellation',
    inject: () => ({ hooks: { notice }, dismiss: () => { notice.set(null) } }),
  }, CancellationNotice))

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'orchestrator',
    order: 5,
    locale: NS,
    label: () => t('view.orchestrator'),
    inject: (_sessionId: SessionId) => ({
      hooks: { boardSessions: ctx.sessions.list, boardWorkspaces: ctx.workspaces.list },
      onAct,
    }),
  }, OrchestratorView))

}
