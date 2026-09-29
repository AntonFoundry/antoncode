/**
 * React wrapper for the orchestrator triage board, registered as the
 * `orchestrator` entry of the conversation view slot. All data arrives
 * through the inject face (plain data + callbacks).
 */
import { useEffect, useMemo, useRef } from 'react'
import { createElement } from 'react'
import type { FC } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Run, RunAction } from './contract.ts'
import { triageBoard } from './render.ts'

/** Inject face the plugin supplies to the view: derived runs plus the action callback. */
export interface OrchestratorInjected {
  /** Root runs derived from the latest board snapshot. */
  runs: Run[]
  /** Action callback invoked with (sessionId, action) from card buttons. */
  onAct: (sessionId: string, action: RunAction) => void
}

/** Props of the view component: the slot's standard share plus the inject face. */
export type OrchestratorViewProps = ConvViewProps & OrchestratorInjected

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
 * Orchestrator tab: health strip + triage board over the derived runs.
 * @param props - Slot share plus the inject face (`runs`, `onAct`).
 * @returns The mounted triage board.
 */
export const OrchestratorView: FC<OrchestratorViewProps> = ({ runs, onAct }) => {
  const memoRuns = useMemo(() => runs, [runs])
  return useVanilla(() => triageBoard(memoRuns, onAct), [memoRuns, onAct])
}
