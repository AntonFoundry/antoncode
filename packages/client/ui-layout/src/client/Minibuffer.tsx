/**
 * Minibuffer: the frame's bottom prompt strip (Emacs echo-area placement,
 * above the tree's bottom edge, below the overlay layer). A controlled
 * component driven entirely by WmFrame state — no store of its own. Every
 * filter prompt shares one shape: a type-to-filter candidate list (↑/↓ or
 * C-p/C-n step, Enter executes, Esc/C-g cancels). Candidates are plain data
 * resolved by WmFrame: buffer kinds for C-x b, workspaces for C-x w, the
 * M-x command roster, themes for load-theme. Candidates carrying a
 * `section` render grouped under one non-row header per run (workspace
 * sessions under their workspace title); motion steps candidate rows only.
 * The list scrolls in the strip and the active row scroll-keeps into view
 * (scrollIntoView 'nearest' — the same behavior the ido prompt owns).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import css from './Minibuffer.module.css'

/** One selectable row: stable id, display label, optional right-side hint. */
export interface MinibufferCandidate {
  id: string
  label: string
  /**
   * Optional grouping title: consecutive candidates sharing a section render
   * under one non-row header. Filtering matches the section text too.
   */
  section?: string
  hint?: string
}

/** One rendered list entry: a section header divider or a candidate row. */
type MinibufferRow =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'candidate'; key: string; candidate: MinibufferCandidate; index: number }

/** Minibuffer props: prompt label, resolved candidates, and the two outcomes. */
export interface MinibufferProps {
  /** Prompt line label, e.g. "Switch buffer" or "Find file". */
  prompt: string
  /** Candidate rows (unfiltered); WmFrame resolves them per prompt kind. */
  candidates: MinibufferCandidate[]
  /** Execute the candidate with this id — or the raw query in free-entry mode. */
  onExecute: (id: string) => void
  /**
   * Free-entry mode: Enter with a typed query executes the RAW query text
   * when no candidate matches (save-layout names a new snapshot). With an
   * empty query it executes the empty string, so the caller can substitute
   * its default. False (every filter prompt) keeps the old contract: Enter
   * only fires on a candidate hit.
   */
  freeEntry?: boolean
  /** Prefill the query (save-layout seeds the auto name so Enter just works). */
  initialQuery?: string
  /**
   * Live-preview the highlighted candidate id while the prompt is open
   * (load-theme), or null to restore whatever preceded the prompt. Fired on
   * selection changes, on cancel, and on prompt close; a fire after an
   * execute is a caller-side no-op (the executed theme released the captured
   * original).
   */
  onPreview?: ((id: string | null) => void) | undefined
  /** Cancel the prompt (Esc / C-g). */
  onCancel: () => void
}

/**
 * The minibuffer strip.
 * @param props - prompt, candidates, execute/cancel callbacks.
 * @returns the strip element, or null when there is nothing to prompt for.
 */
export function Minibuffer({ prompt, candidates, onExecute, onCancel, freeEntry = false, initialQuery = '', onPreview }: MinibufferProps) {
  const [query, setQuery] = useState(initialQuery)
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Opening-swallow guard: the keystroke that opened this prompt (M-x =
  // Option+X, which produces a character on macOS) can land its own character
  // in this input — the browser focuses us during the opening keydown's
  // commit and then performs that keydown's text-insertion default action
  // even though the frame called preventDefault (not every browser honors
  // keydown-preventDefault for Alt-combos). The first input event inside the
  // opening keydown's task is that leak, never the user typing: drop it and
  // let React's controlled-value restore clear the field. Disarmed by the
  // 0ms timer (no human keystroke shares the opening keydown's task) and by
  // this input's own first keydown (its insertion is real typing).
  const swallowRef = useRef(true)
  useEffect(() => {
    const disarm = setTimeout(() => { swallowRef.current = false }, 0)
    return () => { clearTimeout(disarm) }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hit = (c: MinibufferCandidate): boolean => (
      c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) || (c.section?.toLowerCase().includes(q) ?? false)
    )
    return q === '' ? candidates : candidates.filter(hit)
  }, [candidates, query])
  const clamped = Math.min(index, Math.max(0, filtered.length - 1))

  // Render rows: a non-row header opens each section run, candidate buttons
  // carry their filtered index (the motion coordinate — headers never take
  // a step and cannot execute).
  const rows = useMemo<MinibufferRow[]>(() => {
    const out: MinibufferRow[] = []
    let runSection: string | undefined
    for (const [i, candidate] of filtered.entries()) {
      if (candidate.section !== runSection) {
        runSection = candidate.section
        if (runSection !== undefined) out.push({ kind: 'header', key: `header:${candidate.id}`, label: runSection })
      }
      out.push({ kind: 'candidate', key: candidate.id, candidate, index: i })
    }
    return out
  }, [filtered])

  // Theme live-preview: the highlighted candidate previews while the prompt
  // is open; cancel and prompt close restore (a no-op after an execute —
  // loadTheme already released the caller's captured original). The face
  // rides a ref so both effects always call the caller's current callback.
  const onPreviewRef = useRef(onPreview)
  onPreviewRef.current = onPreview
  useEffect(() => {
    onPreviewRef.current?.(filtered[clamped]?.id ?? null)
  }, [filtered, clamped])
  useEffect(() => () => { onPreviewRef.current?.(null) }, [])

  // Scroll-keep: motion, filtering, and mount keep the active row inside the
  // strip's scrolling list — 'nearest' steps one row at a time past the fold
  // and never scrolls when the row is already visible (the ido prompt's
  // behavior, shared by every picker).
  const activeRowRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [filtered, clamped])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    // A keydown on this input is a later, real keystroke — its own insertion
    // must pass the swallow guard.
    swallowRef.current = false
    // C-g works inside the input too (the frame's window guard skips input
    // targets, so the minibuffer owns its own cancel keys).
    if ((e.ctrlKey && (e.key === 'g' || e.key === 'G')) || e.key === 'Escape') {
      e.preventDefault()
      onPreviewRef.current?.(null)
      onCancel()
      return
    }
    // Emacs line motion inside the prompt: C-n / C-p mean down / up, the
    // arrows mean the same (both move the selection, never the caret).
    if (e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'N'))) {
      e.preventDefault()
      setIndex(Math.min(clamped + 1, filtered.length - 1))
      return
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'p' || e.key === 'P'))) {
      e.preventDefault()
      setIndex(Math.max(clamped - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const hit = filtered[clamped]
      if (hit !== undefined) {
        onExecute(hit.id)
        return
      }
      // Free-entry prompts: the typed text IS the answer (a new snapshot
      // name); the empty string delegates the default to the caller.
      if (freeEntry) onExecute(query.trim())
    }
  }

  return (
    <div className={css.minibuffer} data-minibuffer>
      <span className={css.promptLabel}>{prompt}</span>
      <input
        ref={(el) => {
          inputRef.current = el
          el?.focus()
        }}
        className={css.input}
        value={query}
        placeholder={candidates.length === 0 ? 'No candidates' : 'Type to filter…'}
        aria-label={prompt}
        onChange={(e) => {
          // The opening keystroke's leaked character (see the swallow guard)
          // arrives as this input's first change; ignore it so the controlled
          // value stays empty.
          if (swallowRef.current) {
            swallowRef.current = false
            return
          }
          setQuery(e.target.value); setIndex(0)
        }}
        onKeyDown={onKeyDown}
      />
      <ul className={css.candidates}>
        {rows.map((row) => {
          if (row.kind === 'header') {
            return (
              <li key={row.key}>
                <div className={css.sectionLabel}>{row.label}</div>
              </li>
            )
          }
          return (
            <li key={row.key}>
              <button
                type="button"
                ref={row.index === clamped ? (el) => { activeRowRef.current = el } : undefined}
                className={css.candidate}
                data-selected={row.index === clamped || undefined}
                onMouseEnter={() => { setIndex(row.index) }}
                onClick={() => { onExecute(row.candidate.id) }}
              >
                <span className={css.candidateLabel}>{row.candidate.label}</span>
                {row.candidate.hint !== undefined && <span className={css.candidateHint}>{row.candidate.hint}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
