/**
 * The files buffer — dired (compos's dired.scm behavior, client side): one
 * listing per buffer with a navigation toolbar (back / forward / up / home /
 * refresh), clickable crumbs, a selected row the keyboard drives, and
 * Enter-to-enter. History is per buffer (dired.ts pure helpers): a new
 * navigation drops the forward stack. Keys on the focused listing:
 * ↑/↓ or n/p move the selection, Enter enters it, `^` or the `..` row →
 * parent, Alt+←/→ history back/forward, `h` home, `g` refresh, `d` toggles
 * dotfiles, `s` cycles the sort (shift reverses), `q` kills the buffer
 * (compos: every buffer that binds q is a listing you can make again).
 * The listing is the FULL level (directories and files, stat'd): rows carry
 * a kind icon, the classic perms string, size, and date columns (dired.ts
 * formats). Enter descends into a directory; on a plain file it hands the
 * path to the host (openPath — the OS default application).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import {
  diredBack, diredForward, filterDired, formatDiredDate, formatDiredMode, formatDiredSize,
  freshDiredHistory, nextDiredSort, parentOf,
  pushDiredLevel, sortDired, type DiredEntry, type DiredHistory, type DiredSort,
} from './dired.ts'
import css from './FilesBuffer.module.css'

/** Files-buffer props: the listing face (apply-closure over ctx.workspaces) + registry callbacks. */
export interface FilesBufferProps {
  /** The directory currently listed (absent lists the host home). */
  path: string | undefined
  /** List one directory level (always the full listing — files included); an absent path lists the home directory. */
  listDirectory: (path?: string, opts?: { includeFiles?: boolean }, signal?: AbortSignal) => Promise<DirectoryListing>
  /** Open a path with the host OS default application (non-navigable rows). */
  openPath: (path: string) => Promise<void>
  /** Navigate in place: replace this buffer's directory and refetch. */
  onNavigate: (path: string | undefined) => void
  /** Kill this buffer (`q`). */
  onKill: () => void
  /** True when this buffer's window is the frame's focused leaf: the listing
   * then takes the DOM focus, so its keys work without an extra click. */
  active?: boolean
}

/** dired sort cycle names for the mode hint. */
const SORT_LABEL: Record<DiredSort, string> = { name: 'name', size: 'size', modified: 'modified' }

/**
 * The dired listing body.
 * @param props - path, listing face, navigation/kill callbacks.
 * @returns the listing element tree.
 */
export function FilesBuffer({ path, listDirectory, onNavigate, onKill, active, openPath: openWithHost }: FilesBufferProps) {
  const [history, setHistory] = useState<DiredHistory>(() => freshDiredHistory(path))
  const [listing, setListing] = useState<DirectoryListing | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [showDotfiles, setShowDotfiles] = useState(false)
  const [sort, setSort] = useState<DiredSort>('name')
  const [reverse, setReverse] = useState(false)
  const [selected, setSelected] = useState(0)
  const [refreshTick, setRefreshTick] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rowsRef = useRef<HTMLDivElement | null>(null)

  // The pane's WM focus drives the listing's key focus: when this window
  // becomes the focused leaf the container takes the DOM focus, so n/p and
  // the arrows land here without an extra click (Emacs: the selected
  // window's buffer reads the keyboard).
  useEffect(() => {
    if (active === true) containerRef.current?.focus()
  }, [active])

  // Follow the buffer's directory when the registry moves it (C-x b focuses
  // an existing listing, M-x find-file retargets): jump the history there.
  useEffect(() => {
    setHistory(h => pushDiredLevel(h, path))
  }, [path])

  // One fetch per (path, refresh) identity; superseded responses drop.
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(undefined)
    listDirectory(path, { includeFiles: true }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setListing(result)
        setLoading(false)
        setSelected(0)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => { controller.abort() }
  }, [path, listDirectory, refreshTick])

  const rows = useMemo<DiredEntry[]>(() => {
    if (listing === undefined) return []
    return sortDired(filterDired(listing.entries, showDotfiles), sort, reverse)
  }, [listing, showDotfiles, sort, reverse])

  // Keep the selected row visible (the `..` row precedes the first entry).
  useEffect(() => {
    const kid = rowsRef.current?.children[selected + 1]
    if (kid instanceof HTMLElement) kid.scrollIntoView({ block: 'nearest' })
  }, [selected, rows])

  /** Record one navigation (forward stack drops) and move the buffer there. */
  const go = useCallback((target: string | undefined) => {
    setHistory(h => pushDiredLevel(h, target))
    onNavigate(target)
  }, [onNavigate])

  const back = useCallback(() => {
    setHistory((h) => {
      const prev = diredBack(h)
      if (prev !== null) onNavigate(prev.levels[prev.index])
      return prev ?? h
    })
  }, [onNavigate])

  const forward = useCallback(() => {
    setHistory((h) => {
      const next = diredForward(h)
      if (next !== null) onNavigate(next.levels[next.index])
      return next ?? h
    })
  }, [onNavigate])

  const up = useCallback(() => {
    go(listing?.crumbs.at(-2)?.path ?? parentOf(listing?.path ?? ''))
  }, [go, listing])

  const visit = useCallback((entry: DiredEntry) => {
    // A directory descends (a vanished directory surfaces in the listing
    // error state); a plain file opens with the host's default application.
    if (entry.isDirectory === false) void openWithHost(entry.path)
    else go(entry.path)
  }, [go, openWithHost])

  const onKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    // History chords ride Alt (browser convention); plain keys are dired's.
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); back() }
      if (e.key === 'ArrowRight') { e.preventDefault(); forward() }
      return
    }
    // C-p / C-n move the selection (Emacs previous-line/next-line); the
    // global chord parser leaves bare ctrl+letter unbound, so no fight.
    if (e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase()
      if (k === 'p') { e.preventDefault(); setSelected(i => Math.max(i - 1, 0)); return }
      if (k === 'n') { e.preventDefault(); setSelected(i => Math.min(i + 1, rows.length - 1)); return }
      return
    }
    if (e.ctrlKey || e.metaKey) return
    switch (e.key) {
      case 'ArrowDown':
      case 'n':
        e.preventDefault()
        setSelected(i => Math.min(i + 1, rows.length - 1))
        return
      case 'ArrowUp':
      case 'p':
        e.preventDefault()
        setSelected(i => Math.max(i - 1, 0))
        return
      case 'Enter': {
        e.preventDefault()
        const entry = rows[selected]
        if (entry !== undefined) visit(entry)
        return
      }
      case '^':
        e.preventDefault()
        up()
        return
      case 'h': {
        e.preventDefault()
        const home = listing?.crumbs.find(c => c.path === listing.home)?.path ?? listing?.home
        if (home !== undefined) go(home)
        return
      }
      case 'g':
        e.preventDefault()
        setRefreshTick(t => t + 1)
        return
      case 'd':
        e.preventDefault()
        setShowDotfiles(v => !v)
        return
      case 's':
        e.preventDefault()
        if (e.shiftKey) setReverse(v => !v)
        else { const next = nextDiredSort(sort); setSort(next); setReverse(false) }
        return
      case 'q':
        e.preventDefault()
        onKill()
        return
      default: return
    }
  }, [back, forward, go, listing, onKill, rows, selected, sort, up, visit])

  const crumbs = listing?.crumbs ?? []
  const home = listing?.home
  return (
    <div ref={containerRef} className={css.dired} tabIndex={0} onKeyDown={onKey} aria-label={listing === undefined ? 'Dired' : `Dired: ${listing.path}`}>
      <div className={css.toolbar}>
        <button type="button" className={css.toolButton} aria-label="Back" title="Back (Alt+←)" disabled={history.index === 0} onClick={back}>←</button>
        <button type="button" className={css.toolButton} aria-label="Forward" title="Forward (Alt+→)" disabled={history.index >= history.levels.length - 1} onClick={forward}>→</button>
        <button type="button" className={css.toolButton} aria-label="Up" title="Parent (^)" onClick={() => { up() }}>↑</button>
        <button type="button" className={css.toolButton} aria-label="Home" title="Home (h)" disabled={home === undefined || listing?.path === home} onClick={() => { if (home !== undefined) go(home) }}>⌂</button>
        <button type="button" className={css.toolButton} aria-label="Refresh" title="Refresh (g)" onClick={() => { setRefreshTick(t => t + 1) }}>⟳</button>
      </div>
      <div className={css.crumbs}>
        {crumbs.map((crumb, i) => (
          <span key={crumb.path} className={css.crumb}>
            {i > 0 && <span className={css.crumbSep}>/</span>}
            <button type="button" className={css.crumbButton} onClick={() => { go(crumb.path) }}>
              {crumb.name === '' ? crumb.path : crumb.name}
            </button>
          </span>
        ))}
      </div>
      {loading && <div className={css.status}>Listing…</div>}
      {error !== undefined && <div className={css.status} data-error>{error}</div>}
      {!loading && error === undefined && (
        <div ref={rowsRef} className={css.rows} role="list">
          <button type="button" className={css.row} data-up onClick={up}>
            <span className={css.name}>..</span>
            <span className={css.meta}>parent</span>
          </button>
          {rows.map((entry, i) => (
            <button
              type="button"
              key={entry.path}
              role="listitem"
              className={css.row}
              data-hidden={entry.hidden || undefined}
              data-selected={i === selected || undefined}
              onMouseEnter={() => { setSelected(i) }}
              onClick={() => { visit(entry) }}
            >
              <span className={css.name} data-kind={entry.isDirectory === false ? 'file' : 'dir'}>{entry.name}</span>
              <span className={css.meta}>
                <span className={css.perms}>{formatDiredMode(entry.mode)}</span>
                <span className={css.size}>{formatDiredSize(entry.size)}</span>
                <span className={css.date}>{formatDiredDate(entry.modified)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className={css.hint}>
        {`${history.index + 1}/${history.levels.length} · sort: ${SORT_LABEL[sort]}${reverse ? ' (reversed)' : ''} · dotfiles ${showDotfiles ? 'shown' : 'hidden'} · q kills`}
      </div>
    </div>
  )
}
