/**
 * The *scratch* buffer body: a plain editable textarea filling the pane —
 * monospace, no chrome. The draft lives in component state and is written
 * through to the persisted scratch store (`dsh.wm.scratch`) on a short
 * debounce; a bump of the `flushTick` prop (C-x C-s) flushes immediately.
 */
import { useEffect, useRef, useState } from 'react'
import css from './ScratchBuffer.module.css'

/** Debounce for store writes while typing. */
const FLUSH_DEBOUNCE_MS = 500

/** Scratch buffer props: store-backed text write face + the C-x C-s flush tick. */
export interface ScratchBufferProps {
  /** The persisted scratch text (store snapshot). */
  text: string
  /** Persist the draft. */
  onWrite: (text: string) => void
  /** Incremented by C-x C-s; each bump flushes the pending draft now. */
  flushTick: number
}

/**
 * The scratch textarea.
 * @param props - text, write face, flush tick.
 * @returns the buffer body element.
 */
export function ScratchBuffer({ text, onWrite, flushTick }: ScratchBufferProps) {
  const [draft, setDraft] = useState(text)
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef<string | null>(null)
  const lastProp = useRef(text)
  if (text !== lastProp.current) {
    // External write won (another surface saved); adopt it unless we hold a
    // fresher unflushed draft.
    lastProp.current = text
    if (pending.current === null) setDraft(text)
  }

  const flush = (): void => {
    if (timer.current !== undefined) { window.clearTimeout(timer.current); timer.current = undefined }
    if (pending.current !== null) {
      onWrite(pending.current)
      pending.current = null
    }
  }

  useEffect(() => flush, [])

  useEffect(() => {
    if (flushTick > 0) flush()
    // flush reads only refs; the tick is the trigger.
  }, [flushTick])

  return (
    <textarea
      className={css.scratch}
      value={draft}
      aria-label="Scratch buffer"
      onChange={(e) => {
        setDraft(e.target.value)
        pending.current = e.target.value
        if (timer.current === undefined) {
          timer.current = window.setTimeout(() => {
            timer.current = undefined
            flush()
          }, FLUSH_DEBOUNCE_MS)
        }
      }}
    />
  )
}
