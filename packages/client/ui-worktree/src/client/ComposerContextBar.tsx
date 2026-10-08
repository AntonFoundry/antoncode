/**
 * ComposerContextBar: the slim context bar under the composer
 * (conversation.input.dock, after the queue strip) — the repository branch
 * chip on the left, the workspace-mode select beside it, and the base-ref
 * picker (`From origin/main`) on the right. The base is stored with the
 * per-repository mode preference and wins at worktree creation; without an
 * explicit base the host falls back to origin/main, then HEAD. Queried on
 * mount and whenever the session goes idle; the branch chip re-queries on
 * click. Without a session cwd, or when the query reports the directory is
 * not a repository, the bar renders nothing.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionListState, WorktreeStatusView, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { IconBranchOutline16, IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { WorktreeModeSelect, resolveRepo } from './WorktreeModeSelect.tsx'
import type { WorktreeBarActions } from './slots.ts'
import css from './ComposerContextBar.module.css'

export interface ComposerContextBarProps extends WorktreeBarActions {
  /** The owning session id (its summary carries the cwd and running flag). */
  sessionId: SessionId
  /** The standard sessions feed (cwd + running lookup). */
  useSessions: <S>(selector: (state: SessionListState) => S) => S
  /** The standard workspaces feed (worktree projection). */
  useWorkspaces: <S>(selector: (state: WorkspaceListState) => S) => S
}

/**
 * Render the composer context bar, or nothing without repo context.
 * @param props - framework kit + inject face + locale seat.
 * @returns the bar element, or null.
 */
export function ComposerContextBar(
  { sessionId, useSessions, useWorkspaces, setMode, refresh, status, t }:
    ComposerContextBarProps & PropsLocale<'worktree'>,
) {
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const running = useSessions(state => state.byId[sessionId]?.running)
  const prefs = useWorkspaces(state => state.worktrees.prefs)
  const [statusView, setStatusView] = useState<WorktreeStatusView | null>(null)
  const [tick, setTick] = useState(0)
  const [baseOpen, setBaseOpen] = useState(false)
  // A turn that just went idle may have changed branch/stash state; the ref
  // keeps the transition edge (not the flag) as the re-query trigger.
  const wasRunning = useRef(false)
  const requery = (): void => { setTick(value => value + 1) }

  useEffect(() => {
    if (cwd === undefined) return undefined
    const controller = new AbortController()
    void status(cwd, controller.signal)
      .then((view) => { setStatusView(view) })
      .catch(() => { setStatusView(null) })
    return () => { controller.abort() }
  }, [cwd, tick, status])

  useEffect(() => {
    if (wasRunning.current && running !== true) requery()
    wasRunning.current = running === true
  }, [running])

  const repo = useMemo(
    () => (cwd === undefined ? undefined : (resolveRepo(cwd, prefs) ?? { key: cwd, pref: undefined })),
    [cwd, prefs],
  )

  if (cwd === undefined || statusView === null || repo === undefined) return null

  // The effective base: the stored preference wins, then origin/main when the
  // repository has that remote, then the first candidate (HEAD alone at worst).
  const bases = statusView.bases.length > 0 ? statusView.bases : ['HEAD']
  const effectiveBase = repo.pref?.base
    ?? (bases.includes('origin/main') ? 'origin/main' : bases[0] as string)

  const baseItems: MenuEntry[] = bases.map(base => ({
    id: base,
    label: base,
    icon: <IconBranchOutline16 size={16} />,
  }))
  const chooseBase = (id: string): void => {
    setBaseOpen(false)
    const next = { ...(repo.pref ?? { mode: 'checkout' as const }), base: id }
    void setMode(repo.key, next).catch(() => {})
  }

  return (
    <div className={css.bar} data-composer-context-bar>
      <div className={css.left}>
        <button
          type="button"
          className={css.repoChip}
          aria-label={t('bar.repo.aria', { branch: statusView.branch })}
          title={statusView.branch}
          onClick={requery}
        >
          <span className={css.icon} aria-hidden><IconBranchOutline16 size={14} /></span>
          <span className={css.branch}>{statusView.branch}</span>
        </button>
        <WorktreeModeSelect
          sessionId={sessionId}
          useSessions={useSessions}
          useWorkspaces={useWorkspaces}
          setMode={setMode}
          refresh={refresh}
          t={t}
        />
      </div>
      <div className={css.spacer} />
      <Menu
        open={baseOpen}
        items={baseItems}
        selectedId={effectiveBase}
        onSelect={chooseBase}
        onClose={() => { setBaseOpen(false) }}
        side="top"
        align="end"
        anchor={
          <button
            type="button"
            className={css.basePicker}
            aria-label={t('bar.base.aria', { base: effectiveBase })}
            title={t('bar.base.aria', { base: effectiveBase })}
            onClick={() => { setBaseOpen(!baseOpen) }}
          >
            <span className={css.icon} aria-hidden><IconBranchOutline16 size={14} /></span>
            <span className={css.branch}>{t('bar.base', { base: effectiveBase })}</span>
            <span className={css.chevron} aria-hidden><IconChevronDownOutline14 /></span>
          </button>
        }
      />
    </div>
  )
}
