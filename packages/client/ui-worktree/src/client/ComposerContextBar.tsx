/**
 * ComposerContextBar: the composer tool-row cluster inside the input box
 * (conversation.input.left, right after the access select) — one workspace
 * selector and the base-ref picker (`From origin/main`). The selector merges
 * what used to be two adjacent chips: its trigger is the current session's
 * location (the worktree name, or the branch in the main checkout), and its
 * menu holds the per-repository default mode applied to this workspace's
 * NEXT new session — Current checkout, New worktree (fresh worktree per
 * session), or one of the repository's previous worktrees — under a heading
 * that says so, so picking a row never changes the open session. The base is
 * stored with the per-repository mode preference and wins at worktree
 * creation — storing a base alone never changes the mode; without an
 * explicit base the host falls back to origin/main, then HEAD. Queried on
 * mount and whenever the session goes idle; opening the selector re-queries.
 * Without a session cwd the bar renders nothing; a cwd outside any git
 * repository keeps the bar visible with an explanatory menu heading over
 * greyed rows (the base picker stays repo-only).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionId, SessionListState, WorktreeModePrefView, WorktreeStatusView, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { IconBranchOutline16, IconChevronDownOutline14, IconFolderClose16, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry, MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { resolveRepo, worktreeName } from './helpers.ts'
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

/** The mode rows one repository offers, keyed for the preference write. */
function modeRows(
  records: readonly { worktreeId: string; branch: string; path: string; alias?: string }[],
  t: PropsLocale<'worktree'>['t'],
): MenuItem[] {
  const names = new Map<string, number>()
  for (const record of records) {
    const name = worktreeDisplayName(record)
    names.set(name, (names.get(name) ?? 0) + 1)
  }
  return [
    { id: 'checkout', label: t('mode.checkout'), icon: <IconFolderClose16 size={16} /> },
    { id: 'new', label: t('mode.new'), icon: <IconBranchOutline16 size={16} /> },
    ...records.map((record) => {
      const name = worktreeDisplayName(record)
      const display = (names.get(name) ?? 0) > 1 ? `${name} · ${record.branch}` : name
      return {
        id: `reuse:${record.worktreeId}`,
        label: t('mode.reuseNamed', { name: display }),
        icon: <IconBranchOutline16 size={16} />,
      }
    }),
  ]
}

/**
 * The name a worktree reads as: the alias claimed from its titling session
 * when one has claimed it, else the directory basename.
 */
function worktreeDisplayName(record: { path: string; alias?: string }): string {
  return record.alias ?? worktreeName(record.path)
}

/** The preference id a stored (or effective-default) mode selects in the menu. */
function selectedModeId(
  pref: WorktreeModePrefView | undefined,
  locked: boolean,
): string {
  if (pref === undefined) return locked === true ? 'checkout' : 'new'
  if (pref.mode === 'reuse') return `reuse:${pref.worktreeId}`
  return pref.mode
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
  const byRepo = useWorkspaces(state => state.worktrees.byRepo)
  const [statusView, setStatusView] = useState<WorktreeStatusView | null>(null)
  const [tick, setTick] = useState(0)
  const [selectOpen, setSelectOpen] = useState(false)
  const [baseOpen, setBaseOpen] = useState(false)
  const [pending, setPending] = useState(false)
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

  // The projection is boot-loaded and mutation-refreshed; a pull on first
  // mount covers records created elsewhere (another tab, the CLI) since then.
  useEffect(() => { refresh() }, [refresh])

  const repo = useMemo(
    () => (cwd === undefined ? undefined : (resolveRepo(cwd, prefs) ?? { key: cwd, pref: undefined })),
    [cwd, prefs],
  )
  // The worktree record this session's cwd runs in, when any: it labels the
  // trigger with the location fact, never with the next-session preference.
  const worktreeRecord = useMemo(
    () => (cwd === undefined ? undefined : Object.values(byRepo).flat().find(record => record.path === cwd)),
    [byRepo, cwd],
  )
  const worktreeLabel = worktreeRecord === undefined ? undefined : worktreeDisplayName(worktreeRecord)

  // The bar stays visible for every session: a cwd outside any git repository
  // renders the selector with an explanatory heading over greyed rows instead
  // of hiding the feature (discoverability), while the picker stays repo-only.
  const isRepo = statusView !== null && repo !== undefined
  if (cwd === undefined) return null

  // The effective base: the stored preference wins, then origin/main when the
  // repository has that remote, then the first candidate (HEAD alone at worst).
  const repoStatus = isRepo ? (statusView as WorktreeStatusView) : null
  const bases = repoStatus === null ? [] : repoStatus.bases.length > 0 ? repoStatus.bases : ['HEAD']
  const effectiveBase = repo?.pref?.base
    ?? (bases.includes('origin/main') ? 'origin/main' : bases[0] as string)

  const baseItems: MenuEntry[] = bases.map(base => ({
    id: base,
    label: base,
    icon: <IconBranchOutline16 size={16} />,
  }))
  const chooseBase = (id: string): void => {
    setBaseOpen(false)
    /* v8 ignore next -- the picker mounts only for repositories, so a non-repo choose cannot arrive. */
    if (repo === undefined) return
    // Storing a base never changes the mode: a stored preference is kept as-is,
    // and an unstored one keeps the effective default (fresh worktree per
    // session) instead of writing an explicit checkout as a side effect.
    const next = { ...(repo.pref ?? { mode: 'new' as const }), base: id }
    void setMode(repo.key, next).catch(() => {})
  }

  // The trigger is the location fact: the worktree's display name (its
  // claimed alias, or the directory basename) when the session runs in one,
  // else the checked-out branch, else the folder name for a non-repo.
  const locked = repoStatus === null
  const folder = cwd.split('/').pop() ?? cwd
  const location = locked
    ? folder
    : worktreeLabel ?? (repoStatus?.branch ?? folder)
  const locationTitle = locked
    ? t('bar.notRepo', { folder })
    : worktreeLabel !== undefined
      ? t('bar.repo.worktree.aria', { name: worktreeLabel, branch: repoStatus?.branch ?? '' })
      : t('bar.repo.aria', { branch: repoStatus?.branch ?? '' })

  const records = repo === undefined ? [] : (byRepo[repo.key] ?? [])
  const rows = modeRows(records, t)
  const selectItems: MenuEntry[] = locked
    ? [
      { type: 'label', id: 'locked-reason', text: t('bar.notRepo', { folder }) },
      ...rows.map(row => ({ ...row, disabled: true })),
    ]
    : [
      { type: 'label', id: 'current', text: t('bar.current', { name: location }) },
      { type: 'label', id: 'pref-heading', text: t('mode.heading', { repo: worktreeName(repo?.key ?? cwd) }) },
      ...rows,
    ]
  const chooseMode = (id: string): void => {
    setSelectOpen(false)
    /* v8 ignore next -- the trigger is disabled while a write is pending, so a second choose cannot arrive. */
    if (pending || locked) return
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
    void setMode(repo?.key ?? cwd, next).catch(() => {}).finally(() => { setPending(false) })
  }

  return (
    <div className={css.bar} data-composer-context-bar>
      <Menu
        open={selectOpen}
        items={selectItems}
        selectedId={selectedModeId(repo?.pref, locked)}
        onSelect={chooseMode}
        onClose={() => { setSelectOpen(false) }}
        side="top"
        align="start"
        anchor={
          <button
            type="button"
            className={css.repoChip}
            aria-label={locationTitle}
            title={locationTitle}
            disabled={pending}
            onClick={() => {
              // Opening is the chip's old requery edge: branch and stash facts
              // refresh before the menu renders them.
              if (!selectOpen) requery()
              setSelectOpen(!selectOpen)
            }}
          >
            <span className={css.icon} aria-hidden><IconBranchOutline16 size={14} /></span>
            <span className={css.branch}>{location}</span>
            <span className={css.chevron} aria-hidden><IconChevronDownOutline14 /></span>
          </button>
        }
      />
      {repoStatus !== null && (
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
      )}
    </div>
  )
}
