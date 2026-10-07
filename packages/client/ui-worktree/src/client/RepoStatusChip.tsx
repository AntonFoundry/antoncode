/**
 * RepoStatusChip: the session header's leading status chip
 * (conversation.session.header.actions, static-context negative order) —
 * branch plus a stash badge for the session's working directory, in the
 * competitor's "Stash 1" spirit. Queried on mount and whenever the session
 * goes idle; click re-queries. Without a cwd, or when the query reports the
 * directory is not a repository, the chip renders nothing.
 */

import { useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionListState, WorktreeStatusView } from '@deepseek-ai/dsh-client-runtime/client'
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RepoStatusActions } from './slots.ts'
import css from './RepoStatusChip.module.css'

export interface RepoStatusChipProps extends RepoStatusActions {
  /** The owning session id (its summary carries the cwd and running flag). */
  sessionId: SessionId
  /** The standard sessions feed (cwd + running lookup). */
  useSessions: <S>(selector: (state: SessionListState) => S) => S
}

/**
 * Render the repo-status chip, or nothing without repo context.
 * @param props - framework kit + inject face + locale seat.
 * @returns the chip element, or null.
 */
export function RepoStatusChip(
  { sessionId, useSessions, status, t }: RepoStatusChipProps & PropsLocale<'worktree'>,
) {
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const running = useSessions(state => state.byId[sessionId]?.running)
  const [statusView, setStatusView] = useState<WorktreeStatusView | null>(null)
  const [tick, setTick] = useState(0)
  // A turn that just went idle may have changed branch/stash state; the ref
  // keeps the transition edge (not the flag) as the re-query trigger.
  const wasRunning = useRef(false)
  const query = (): void => { setTick(value => value + 1) }

  useEffect(() => {
    if (cwd === undefined) return undefined
    const controller = new AbortController()
    void status(cwd, controller.signal)
      .then((view) => { setStatusView(view) })
      .catch(() => { setStatusView(null) })
    return () => { controller.abort() }
  }, [cwd, tick, status])

  // The idle edge re-queries (a turn may have changed branch/stash state);
  // the ref keeps the transition itself — not the flag — as the trigger.
  useEffect(() => {
    if (wasRunning.current && running !== true) query()
    wasRunning.current = running === true
  }, [running])

  if (cwd === undefined || statusView === null) return null
  return (
    <button
      type="button"
      className={css.chip}
      aria-label={t('status.aria', { branch: statusView.branch, count: statusView.stashCount })}
      title={statusView.branch}
      onClick={query}
    >
      <span className={css.icon} aria-hidden><IconBranchOutline16 size={14} /></span>
      <span className={css.branch}>{statusView.branch}</span>
      {statusView.stashCount > 0 && (
        <span className={css.stash}>{t('status.stash', { count: statusView.stashCount })}</span>
      )}
    </button>
  )
}
