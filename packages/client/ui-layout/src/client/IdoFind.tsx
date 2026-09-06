/**
 * Ido find-file: the interactive directory prompt (Emacs ido-mode over the
 * wire). One active directory, a typed segment narrowing its live listing
 * (flex match — every query character must appear in order), the candidate
 * list docked above the echo area. The query is path-aware: `~` jumps to
 * the host home, a leading `/` to the root, and each complete segment
 * before a slash descends into its directory match (one refetch per
 * segment) while the tail flex-narrows the resolved level. Keys: ↑/↓ or
 * C-p/C-n move the selection;
 * Enter or Tab on a directory descends into it (Enter on a plain file lands
 * the full dired window at its directory); C-j opens dired here from any
 * state; Backspace deletes a character and, with an empty segment, walks up
 * one level; C-g/Escape cancels. All listing reads ride the injected
 * `listDirectory` face (the browse capability, files included).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import { DiredIcon } from './DiredIcon.tsx'
import { diredIconKind, flexDiredMatch, formatDiredMode, formatDiredSize, type DiredEntry } from './dired.ts'
import css from './Minibuffer.module.css'

/** Ido-find props: the injected listing face and the two outcomes. */
export interface IdoFindProps {
  /** The directory the prompt starts at (absent = the host home). */
  initialDir: string | undefined
  /** List one directory level (files included); an absent path lists home. */
  listDirectory: (path?: string, opts?: { includeFiles?: boolean }, signal?: AbortSignal) => Promise<DirectoryListing>
  /** Land the full dired window at this directory (Enter on a file, C-j). */
  onOpen: (dir: string) => void
  /** Cancel the prompt (C-g / Escape). */
  onCancel: () => void
}

/**
 * The ido find-file prompt.
 * @param props - initial directory, listing face, open/cancel callbacks.
 * @returns the prompt element.
 */
export function IdoFind({ initialDir, listDirectory, onOpen, onCancel }: IdoFindProps) {
  const [dir, setDir] = useState<string | undefined>(initialDir)
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<DirectoryListing | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // One fetch per directory identity; superseded responses drop.
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(undefined)
    listDirectory(dir, { includeFiles: true }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setListing(result)
        setLoading(false)
        setIndex(0)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => { controller.abort() }
  }, [dir, listDirectory])

  // Path semantics for the query (Emacs find-file): `~` jumps to the host
  // home, a leading `/` to the filesystem root, and every complete segment
  // before a slash descends into its directory match — one segment per
  // pass, the refetch chain consuming the rest. The final (partial)
  // segment stays as the flex query over the resolved directory.
  useEffect(() => {
    if (query.startsWith('~')) {
      const home = listing?.home
      if (home === undefined) return
      setDir(home)
      setQuery(query.slice(1).replace(/^\//, ''))
      setIndex(0)
      return
    }
    if (query.startsWith('/')) {
      setDir('/')
      setQuery(query.replace(/^\/+/, ''))
      setIndex(0)
      return
    }
    const slash = query.indexOf('/')
    if (slash === -1) return
    const head = query.slice(0, slash)
    const rest = query.slice(slash + 1)
    if (head === '') return
    const entries = listing?.entries ?? []
    // Exact name wins; otherwise the current flex selection descends (ido
    // commits the best match at the slash).
    const exact = entries.find(e => e.name === head && e.isDirectory !== false)
    const hit = exact ?? flexDiredMatch(entries, head)[0]
    if (hit === undefined || hit.isDirectory === false) return
    setDir(hit.path)
    setQuery(rest)
    setIndex(0)
  }, [query, listing])

  // Ido flex match over the active directory's rows.
  const matches = useMemo<DiredEntry[]>(() => {
    const rows = listing?.entries ?? []
    return flexDiredMatch(rows, query)
  }, [listing, query])
  const clamped = Math.min(index, Math.max(0, matches.length - 1))

  /** Descend into a directory row (a plain file lands dired at its directory). */
  const descend = useCallback((entry: DiredEntry) => {
    if (entry.isDirectory === false) {
      onOpen(dir ?? listing?.home ?? '.')
      return
    }
    setDir(entry.path)
    setQuery('')
  }, [dir, listing, onOpen])

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>): void => {
    // C-g works inside the input (the frame's window guard skips input
    // targets, so the prompt owns its own cancel keys).
    if ((e.ctrlKey && (e.key === 'g' || e.key === 'G')) || e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase()
      if (k === 'p') {
        e.preventDefault()
        setIndex(() => Math.max(clamped - 1, 0))
        return
      }
      if (k === 'n') {
        e.preventDefault()
        setIndex(() => Math.min(clamped + 1, matches.length - 1))
        return
      }
      // C-j: open the full dired window at the active directory, any state.
      if (k === 'j') {
        e.preventDefault()
        onOpen(dir ?? listing?.home ?? '.')
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex(() => Math.min(clamped + 1, matches.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex(() => Math.max(clamped - 1, 0))
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const hit = matches[clamped]
      if (hit !== undefined) descend(hit)
      else if (e.key === 'Enter') onOpen(dir ?? listing?.home ?? '.')
      return
    }
    if (e.key === 'Backspace') {
      // Empty segment: walk up one level (the crumbs chain is the host's own
      // ancestry; the pure parentOf fallback covers a listing still loading).
      if (query === '') {
        e.preventDefault()
        const parent = listing?.crumbs.at(-2)?.path
        if (parent !== undefined) { setDir(parent); setIndex(0) }
      }
      return
    }
  }, [clamped, descend, dir, listing, matches.length, onCancel, onOpen, query])

  // Keep the input focus (the candidates are buttons; clicking one must not
  // strand the keyboard).
  useEffect(() => { inputRef.current?.focus() }, [dir, loading])

  // Every match renders — the strip's own list scrolls (no fixed row cap;
  // a level the host cut reports `truncated`, surfaced in the placeholder).
  const listRef = useRef<HTMLUListElement | null>(null)
  useEffect(() => {
    const kid = listRef.current?.children[clamped]
    if (kid instanceof HTMLElement) kid.scrollIntoView({ block: 'nearest' })
  }, [clamped, matches.length])
  const label = `Find file: ${dir ?? listing?.home ?? '~'}/${query}`
  return (
    <div className={css.minibuffer} data-minibuffer data-ido>
      <span className={css.promptLabel}>{label}</span>
      <input
        ref={(el) => {
          inputRef.current = el
          el?.focus()
        }}
        className={css.input}
        value={query}
        placeholder={loading ? 'Listing…' : matches.length === 0 ? 'No match' : listing?.truncated === true ? `Type to narrow… (${matches.length} shown — level cut at the host bound)` : 'Type to narrow…'}
        aria-label="Find file"
        onChange={(e) => { setQuery(e.target.value); setIndex(0) }}
        onKeyDown={onKeyDown}
      />
      {error !== undefined && <div className={css.promptLabel} data-error>{error}</div>}
      <ul ref={listRef} className={css.candidates}>
        {matches.map(c => (
          <li key={c.path}>
            <button
              type="button"
              className={css.candidate}
              data-selected={matches.indexOf(c) === clamped || undefined}
              onMouseEnter={() => { setIndex(matches.indexOf(c)) }}
              onClick={() => { descend(c); inputRef.current?.focus() }}
            >
              <span className={css.candidateLabel}>
                <DiredIcon kind={diredIconKind(c.name, c.isDirectory)} />
                {c.name}
              </span>
              <span className={css.candidateHint}>
                {formatDiredMode(c.mode)} {formatDiredSize(c.size)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
