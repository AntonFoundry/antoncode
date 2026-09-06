/**
 * Minibuffer: the frame's bottom prompt strip (Emacs echo-area placement,
 * above the tree's bottom edge, below the overlay layer). A controlled
 * component driven entirely by WmFrame state — no store of its own. Two
 * prompt kinds share one shape: a type-to-filter candidate list (max 8
 * visible, ↑/↓ cycles, Enter executes, Esc/C-g cancels). Candidates are
 * plain data resolved by WmFrame: buffer kinds for C-x b, workspaces for
 * C-x w.
 */
import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import css from './Minibuffer.module.css'

/** One selectable row: stable id, display label, optional right-side hint. */
export interface MinibufferCandidate {
  id: string
  label: string
  hint?: string
}

/** Minibuffer props: prompt label, resolved candidates, and the two outcomes. */
export interface MinibufferProps {
  /** Prompt line label, e.g. "Switch buffer" or "Find file". */
  prompt: string
  /** Candidate rows (unfiltered); WmFrame resolves them per prompt kind. */
  candidates: MinibufferCandidate[]
  /** Execute the candidate with this id — or the raw query in free-entry mode. */
  onExecute: (id: string) => void
  /** Cancel the prompt (Esc / C-g). */
  onCancel: () => void
}

/**
 * The minibuffer strip.
 * @param props - prompt, candidates, execute/cancel callbacks.
 * @returns the strip element, or null when there is nothing to prompt for.
 */
export function Minibuffer({ prompt, candidates, onExecute, onCancel }: MinibufferProps) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hits = q === ''
      ? candidates
      : candidates.filter(c => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
    return hits
  }, [candidates, query])
  const clamped = Math.min(index, Math.max(0, filtered.length - 1))

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    // C-g works inside the input too (the frame's window guard skips input
    // targets, so the minibuffer owns its own cancel keys).
    if ((e.ctrlKey && (e.key === 'g' || e.key === 'G')) || e.key === 'Escape') {
      e.preventDefault()
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
      if (hit !== undefined) onExecute(hit.id)
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
        onChange={(e) => { setQuery(e.target.value); setIndex(0) }}
        onKeyDown={onKeyDown}
      />
      <ul className={css.candidates}>
        {filtered.map((c, i) => (
          <li key={c.id}>
            <button
              type="button"
              className={css.candidate}
              data-selected={i === clamped || undefined}
              onMouseEnter={() => { setIndex(i) }}
              onClick={() => { onExecute(c.id) }}
            >
              <span className={css.candidateLabel}>{c.label}</span>
              {c.hint !== undefined && <span className={css.candidateHint}>{c.hint}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
