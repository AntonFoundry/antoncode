/**
 * Browser orchestrator plugin: registers the `orchestrator` entry of the
 * conversation view slot (header becomes [ Orchestrator | Workflows | Chat ];
 * Chat stays the default fallback), fed by the `orchestrator.board` RPC with a
 * refresh-on-inject pull plus an interval poll. The Workflows tab lives in
 * `@deepseek-ai/dsh-client-ui-flowbuilder`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { deriveRuns, type BoardSnapshot } from './bridge.ts'
import type { RunAction } from './contract.ts'
import { NS, en, zh } from './locales.ts'
import { OrchestratorView } from './views.tsx'

/** Required services: the conversation slot, the locale service, the connection
 *  carrying the API client, and the runtime sessions service (display titles). */
export const inject = ['slots', 'locale', 'connection', 'sessions']

/** Board poll interval. The snapshot is small (summaries only); 15s keeps cards near-live. */
const POLL_MS = 15_000

/**
 * Client plugin body: register the two view tabs, pull the board, and keep it
 * fresh. Both registrations ride the slot service's effect wrapper, so plugin
 * unload removes the tabs; the poll interval is disposed with the fiber.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-orchestrator: dictionaries')
  // Registration-time text (the view tab labels) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration.
  const t = ctx.locale.bind(NS)
  const api = (ctx.get('connection') as unknown as { api: IApiClient }).api
  let board: BoardSnapshot = { items: [], archivedSessionIds: [], sessions: [] }

  const pull = async (): Promise<void> => {
    try {
      const { result } = await api.orchestrator.board({})
      if (result.ok) board = result.value
      else console.error('[ui-orchestrator] board failed:', result.error.code, result.error.message)
    } catch (error) {
      // Keep the last good snapshot; the poll retries.
      console.error('[ui-orchestrator] board request failed:', error)
    }
  }

  const onAct = (sessionId: string, action: RunAction): void => {
    if (action !== 'kill') {
      // approve / retry / inject note / focus have no server-side action yet.
      console.info('[ui-orchestrator] unhandled action', action, sessionId)
      return
    }
    void api.orchestrator.act({ sessionId: sessionId as SessionId, action: 'kill' })
      .then(() => pull())
      .catch((error: unknown) => { console.error('[ui-orchestrator] act failed:', error) })
  }

  // Card titles come from the runtime sessions service's human-facing label
  // (durable title, then workspace basename, then id) — the board wire's
  // summaries carry no title projection of their own.
  const titles = (): ReadonlyMap<string, string> => {
    const byId = (ctx.sessions as unknown as {
      list?: { getSnapshot?: () => { byId?: Record<string, { displayTitle?: string }> } }
    }).list?.getSnapshot?.().byId
    const map = new Map<string, string>()
    for (const summary of board.sessions) {
      const label = byId?.[summary.sessionId]?.displayTitle
      if (label !== undefined && label !== summary.sessionId) map.set(summary.sessionId, label)
    }
    return map
  }

  const injected = () => deriveRuns(board, { titles: titles() })

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'orchestrator',
    order: 5,
    locale: NS,
    label: () => t('view.orchestrator'),
    inject: (_sessionId: SessionId) => ({ runs: injected(), onAct }),
  }, OrchestratorView))

  // Refresh-on-inject pull plus a poll: a newly mounted view tab reads a
  // snapshot at most POLL_MS old. Within an already-open view, refresh waits
  // for the next remount (documented limitation).
  ctx.effect(() => {
    void pull()
    const id = setInterval(() => { void pull() }, POLL_MS)
    return () =>{  clearInterval(id) }
  }, 'ui-orchestrator: board poll')
}
