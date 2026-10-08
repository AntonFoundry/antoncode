/**
 * WorktreeModeSelect: the composer context bar's mode control that picks the
 * workspace mode applied to this workspace's NEXT new session —
 * Current checkout, New worktree (fresh worktree per session), or one of the
 * repository's previous worktrees. The value is the per-repository default
 * mode the runtime's New Session flow honors; live state (the projection and
 * the session's cwd) arrives through the standard kit, the write verb through
 * inject. Without a session cwd or any governing repository the entry renders
 * nothing.
 */

import { useEffect, useMemo, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionListState, WorktreeModePrefView, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { IconBranchOutline16, IconChevronDownOutline14, IconFolderClose16, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorktreeSelectActions } from './slots.ts'
import css from './WorktreeModeSelect.module.css'

export interface WorktreeModeSelectProps extends WorktreeSelectActions {
  /** The owning session id (its summary carries the cwd). */
  sessionId: SessionId
  /** The standard sessions feed (cwd lookup). */
  useSessions: <S>(selector: (state: SessionListState) => S) => S
  /** The standard workspaces feed (worktree projection). */
  useWorkspaces: <S>(selector: (state: WorkspaceListState) => S) => S
  /** Render the trigger disabled (the directory is not a git repository). */
  disabled?: boolean
  /** Tooltip explaining a disabled trigger. */
  disabledTitle?: string
}

/**
 * The repository key a cwd's default mode is stored under: the exact key, or
 * the longest recorded key containing the path as a child (`repo/…`) or in
 * the worktree sibling layout (`repo.…`). Mirrors the runtime's resolution so
 * the control and the New Session flow agree.
 */
/**
 * The governing repository entry for a cwd: the exact key, or the longest
 * recorded key containing the path as a child (`repo/…`) or in the worktree
 * sibling layout (`repo.…`). Mirrors the runtime's resolution so the control
 * and the New Session flow agree.
 */
export function resolveRepo(
  path: string,
  prefs: WorkspaceListState['worktrees']['prefs'],
): { key: string; pref: WorktreeModePrefView } | undefined {
  const direct = Object.entries(prefs).find(([repo]) => repo === path)
  if (direct !== undefined) return { key: direct[0], pref: direct[1] }
  let best: { key: string; pref: WorktreeModePrefView } | undefined
  for (const [repo, pref] of Object.entries(prefs)) {
    const contained = path.startsWith(`${repo}/`) || path.startsWith(`${repo}.`)
    if (contained && (best === undefined || repo.length > best.key.length)) best = { key: repo, pref }
  }
  return best
}

/** The trigger label for a mode; no stored preference shows the effective default, and a reuse mode whose record vanished falls back to the generic label. */
function modeLabel(
  pref: WorktreeModePrefView | undefined,
  records: readonly { worktreeId: string; branch: string }[],
  t: PropsLocale<'worktree'>['t'],
): string {
  if (pref === undefined || pref.mode === 'checkout') return t('mode.checkout')
  if (pref.mode === 'new') return t('mode.new')
  const reused = records.find(record => record.worktreeId === pref.worktreeId)
  return reused === undefined ? t('mode.reuse') : t('mode.reuseNamed', { branch: reused.branch })
}

/**
 * Render the workspace-mode select, or nothing without repo context.
 * @param props - framework kit + inject face + locale seat.
 * @returns the select element, or null.
 */
export function WorktreeModeSelect(
  { sessionId, useSessions, useWorkspaces, setMode, refresh, disabled, disabledTitle, t }:
    WorktreeModeSelectProps & PropsLocale<'worktree'>,
) {
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const prefs = useWorkspaces(state => state.worktrees.prefs)
  const byRepo = useWorkspaces(state => state.worktrees.byRepo)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  // The projection is boot-loaded and mutation-refreshed; a pull on first
  // mount covers records created elsewhere (another tab, the CLI) since then.
  useEffect(() => { refresh() }, [refresh])

  // A repository with no stored preference still renders (key = cwd): the
  // effective default is checkout, and choosing a mode writes the first pref.
  const repo = useMemo(
    () => (cwd === undefined ? undefined : (resolveRepo(cwd, prefs) ?? { key: cwd, pref: undefined })),
    [cwd, prefs],
  )
  // repo is defined exactly when cwd is (the memo falls back to the cwd key).
  if (cwd === undefined || repo === undefined) return null

  const records = byRepo[repo.key] ?? []
  const items: MenuEntry[] = [
    { id: 'checkout', label: t('mode.checkout'), icon: <IconFolderClose16 size={16} /> },
    { id: 'new', label: t('mode.new'), icon: <IconBranchOutline16 size={16} /> },
    ...records.map(record => ({
      id: `reuse:${record.worktreeId}`,
      label: t('mode.reuseNamed', { branch: record.branch }),
      icon: <IconBranchOutline16 size={16} />,
    })),
  ]

  const choose = (id: string): void => {
    setOpen(false)
    /* v8 ignore next -- the trigger is disabled while a write is pending, so a second choose cannot arrive. */
    if (pending) return
    const next: WorktreeModePrefView | undefined = id === 'checkout'
      ? { mode: 'checkout' }
      : id === 'new'
        ? { mode: 'new' }
        : id.startsWith('reuse:')
          ? { mode: 'reuse', worktreeId: id.slice('reuse:'.length) as never }
          : undefined
    /* v8 ignore next -- the Menu delivers only this menu's entry ids; the miss arm is a narrowing guard. */
    if (next === undefined) return
    setPending(true)
    void setMode(repo.key, next).catch(() => {}).finally(() => { setPending(false) })
  }

  const label = modeLabel(repo.pref, records, t)
  return (
    <Menu
      open={open}
      items={items}
      selectedId={repo.pref === undefined
        ? 'checkout'
        : repo.pref.mode === 'reuse'
          ? `reuse:${repo.pref.worktreeId}`
          : repo.pref.mode}
      onSelect={choose}
      onClose={() => { setOpen(false) }}
      side="top"
      anchor={
        <button
          type="button"
          className={css.trigger}
          aria-label={t('mode.aria', { name: label })}
          title={disabled === true ? disabledTitle : repo.pref?.mode === 'new' ? t('hint.new') : undefined}
          disabled={pending || disabled === true}
          onClick={() => { setOpen(!open) }}
        >
          <span className={css.triggerIcon} aria-hidden><IconBranchOutline16 size={16} /></span>
          <span className={css.triggerLabel}>{label}</span>
          <span className={css.chevron} aria-hidden><IconChevronDownOutline14 /></span>
        </button>
      }
    />
  )
}
