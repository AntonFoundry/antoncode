/**
 * RepoStatusChip: the session header's leading status chip
 * (conversation.session.header.actions, static-context negative order) —
 * the session's own workspace at a glance: the worktree name when the
 * session's cwd is a registered worktree (the tooltip carries the branch),
 * the git branch otherwise — plus a stash badge, in the competitor's
 * "Stash 1" spirit. Queried on mount and whenever the session goes idle;
 * click re-queries. Without a cwd, or when the query reports the directory
 * is not a repository, the chip renders nothing.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorktreeStatus } from '@deepseek-ai/dsh-api-workspace-controller/worktree-types'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { worktreeName } from './helpers.ts'
import type { RepoStatusActions } from './slots.ts'
import css from './RepoStatusChip.module.css'

export interface RepoStatusChipProps extends RepoStatusActions {
  /** The owning session id (its summary carries the cwd and running flag). */
  sessionId: SessionId
  /** The standard sessions feed (cwd + running lookup). */
  useSessions: <S>(selector: (state: SessionListState) => S) => S
  /** The standard workspaces feed (worktree projection). */
  useWorkspaces: <S>(selector: (state: WorkspaceSnapshot) => S) => S
}

/**
 * Render the repo-status chip, or nothing without repo context.
 * @param props - framework kit + inject face + locale seat.
 * @returns the chip element, or null.
 */
export function RepoStatusChip(
  { sessionId, useSessions, useWorkspaces, status, t }: RepoStatusChipProps & PropsLocale<'worktree'>,
) {
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const running = useSessions(state => state.byId[sessionId]?.running)
  const byRepo = useWorkspaces(state => state.worktrees.byRepo)
  const [statusView, setStatusView] = useState<WorktreeStatus | null>(null)
  const [tick, setTick] = useState(0)
  // A turn that just went idle may have changed branch/stash state; the ref
  // keeps the transition edge (not the flag) as the re-query trigger.
  const wasRunning = useRef(false)
  const query = (): void => { setTick(value => value + 1) }
  // The worktree record this session's cwd runs in, when any: it names the
  // chip after the worktree instead of the branch so the session's own
  // workspace is readable at a glance.
  const worktree = useMemo(
    () => (cwd === undefined ? undefined : Object.values(byRepo).flat().find(record => record.path === cwd)),
    [byRepo, cwd],
  )

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
  const aria = worktree === undefined
    ? t('status.aria', { branch: statusView.branch, count: statusView.stashCount })
    : t('status.worktree.aria', { name: worktreeName(worktree.path), branch: statusView.branch, count: statusView.stashCount })
  return (
    <button
      type="button"
      className={css.chip}
      aria-label={aria}
      title={aria}
      onClick={query}
    >
      <span className={css.icon} aria-hidden><IconBranchOutlineRegular size={14} /></span>
      <span className={css.branch}>
        {worktree === undefined ? statusView.branch : worktreeName(worktree.path)}
      </span>
      {statusView.stashCount > 0 && (
        <span className={css.stash}>{t('status.stash', { count: statusView.stashCount })}</span>
      )}
    </button>
  )
}
