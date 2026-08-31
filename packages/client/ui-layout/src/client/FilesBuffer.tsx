/**
 * The files buffer — dired-lite (compos's dired.scm behavior, trimmed to the
 * wire): one listing per buffer, directories-then-entries rows with clickable
 * crumbs above them. Enter/click navigates a row in place (replacing the
 * buffer's directory and refetching); the host's browse capability lists
 * enterable rows only, so a row that refuses navigation falls back to
 * opening it through `host.openPath`. Keys on the focused listing: `u` or the
 * `..` row → parent, `d` toggles dotfiles, `s` cycles the sort (shift
 * reverses), `q` kills the buffer (compos: every buffer that binds q is a
 * listing you can make again). Sorting/filtering live in dired.ts (pure).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import { filterDired, nextDiredSort, parentOf, sortDired, type DiredEntry, type DiredSort } from './dired.ts'
import css from './FilesBuffer.module.css'

/** Files-buffer props: the listing face (apply-closure over ctx.workspaces) + registry callbacks. */
export interface FilesBufferProps {
  /** The directory currently listed (absent lists the host home). */
  path: string | undefined
  /** List one directory level; an absent path lists the home directory. */
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  /** Open a path with the host OS default application (non-navigable rows). */
  openPath: (path: string) => Promise<void>
  /** Navigate in place: replace this buffer's directory and refetch. */
  onNavigate: (path: string | undefined) => void
  /** Kill this buffer (`q`). */
  onKill: () => void
}

/** dired sort cycle names for the mode hint. */
const SORT_LABEL: Record<DiredSort, string> = { name: 'name', size: 'size', modified: 'modified' }

/**
 * The dired-lite listing body.
 * @param props - path, listing face, navigation/kill callbacks.
 * @returns the listing element tree.
 */
export function FilesBuffer({ path, listDirectory, openPath, onNavigate, onKill }: FilesBufferProps) {
  const [listing, setListing] = useState<DirectoryListing | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [showDotfiles, setShowDotfiles] = useState(false)
  const [sort, setSort] = useState<DiredSort>('name')
  const [reverse, setReverse] = useState(false)

  // One fetch per path identity; superseded responses drop on the floor.
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(undefined)
    listDirectory(path, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setListing(result)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => { controller.abort() }
  }, [path, listDirectory])

  const rows = useMemo<DiredEntry[]>(() => {
    if (listing === undefined) return []
    return sortDired(filterDired(listing.entries, showDotfiles), sort, reverse)
  }, [listing, showDotfiles, sort, reverse])

  const go = useCallback((target: string | undefined) => {
    onNavigate(target)
  }, [onNavigate])

  const visit = useCallback((entry: DiredEntry) => {
    // The wire lists enterable rows; a refused navigation (a file, or an
    // unreadable target) falls back to an OS open.
    go(entry.path)
    void listDirectory(entry.path).catch(() => openPath(entry.path))
  }, [go, listDirectory, openPath])

  const onKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    switch (e.key) {
      case 'u':
        e.preventDefault()
        go(listing?.crumbs.at(-2)?.path ?? parentOf(listing?.path ?? ''))
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
  }, [go, listing, onKill, sort])

  const crumbs = listing?.crumbs ?? []
  return (
    <div className={css.dired} tabIndex={0} onKeyDown={onKey} aria-label={listing === undefined ? 'Dired' : `Dired: ${listing.path}`}>
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
        <div className={css.rows} role="list">
          <button type="button" className={css.row} data-up onClick={() => { go(crumbs.at(-2)?.path ?? parentOf(listing?.path ?? '')) }}>
            <span className={css.name}>..</span>
            <span className={css.meta}>parent</span>
          </button>
          {rows.map(entry => (
            <button
              type="button"
              key={entry.path}
              role="listitem"
              className={css.row}
              data-hidden={entry.hidden || undefined}
              onClick={() => { visit(entry) }}
            >
              <span className={css.name}>{entry.name}</span>
              <span className={css.meta}>
                {entry.size !== undefined ? `${entry.size} B` : ''}
                {entry.modified !== undefined ? new Date(entry.modified).toLocaleDateString() : ''}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className={css.hint}>
        {`sort: ${SORT_LABEL[sort]}${reverse ? ' (reversed)' : ''} · dotfiles ${showDotfiles ? 'shown' : 'hidden'} · q kills`}
      </div>
    </div>
  )
}
