/**
 * React wrapper for the orchestrator triage board, registered as the
 * `orchestrator` entry of the conversation view slot. All data arrives
 * through the inject face (plain data + callbacks).
 */
import { useEffect, useMemo, useRef } from 'react'
import { createElement } from 'react'
import type { FC } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { HostObservable, PropsHooks } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { deriveRuns } from './bridge.ts'
import type { RunAction } from './contract.ts'
import { triageBoard } from './render.ts'

/** Controller sources and cancellation callback supplied by the plugin. */
export interface OrchestratorInjected {
  /** Controller sources bound into selector hooks by the renderer. */
  hooks: {
    boardSessions: HostObservable<SessionListState>
    boardWorkspaces: HostObservable<WorkspaceSnapshot>
  }
  /** Action callback invoked with (sessionId, action) from card buttons. */
  onAct: (sessionId: string, action: RunAction) => void
}

/** Props of the view component: the slot's standard share plus the inject face. */
export type OrchestratorViewProps = ConvViewProps & Omit<OrchestratorInjected, 'hooks'> & PropsHooks<OrchestratorInjected['hooks']>

/** Mounts one vanilla-DOM subtree into a flex-filling host div, rebuilt on factory change. */
function useVanilla(factory: () => HTMLElement, deps: readonly unknown[]): ReturnType<typeof createElement> {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (el !== null) el.replaceChildren(factory())
  }, deps)
  return createElement('div', {
    ref,
    style: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
  })
}

/**
 * Orchestrator tab over the subscribed Controller snapshots.
 * @param props - Slot share plus the inject face (source hooks and `onAct`).
 * @returns The mounted triage board.
 */
export const OrchestratorView: FC<OrchestratorViewProps> = ({ useBoardSessions, useBoardWorkspaces, onAct }) => {
  const sessions = useBoardSessions(value => value)
  const workspaces = useBoardWorkspaces(value => value)
  const memoRuns = useMemo(() => deriveRuns({
    items: [...workspaces.items],
    archivedSessionIds: [...workspaces.archivedSessionIds],
    sessions: Object.values(sessions.byId),
    projectionsBySession: sessions.projectionsBySession,
  }, { titles: new Map(Object.values(sessions.byId).map(row => [row.id, row.displayTitle])) }), [sessions, workspaces])
  return useVanilla(() => triageBoard(memoRuns, onAct), [memoRuns, onAct])
}
