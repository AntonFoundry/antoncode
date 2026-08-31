/**
 * Emacs chord parser for the window-manager frame: a pure keydown
 * classifier. The C-x / C-c prefixes are state machines ACROSS keypresses,
 * so the caller (WmFrame) carries the armed prefix and passes it in; this
 * module stays stateless and DOM-free.
 *
 * Text-safety contract: the INPUT/TARGET guard lives in WmFrame (only the
 * event target knows the element kind), so this parser never sees — and
 * never needs to see — whether typing was in a text field.
 */

/** One window command the chord tables bind. */
export type WmCommand =
  /** Open the switch-buffer minibuffer (C-x b). */
  | 'switch-buffer'
  /** Find-file minibuffer: type a path, Enter opens a dired buffer (C-x C-f). */
  | 'find-file'
  /** Open the dired buffer at the home directory (C-x d). */
  | 'dired'
  /** Open the kill-buffer minibuffer (C-x k). */
  | 'kill-buffer'
  /** Split the focused leaf below (C-x 2). */
  | 'split-below'
  /** Split the focused leaf right (C-x 3). */
  | 'split-right'
  /** Close the focused leaf, canClose-guarded (C-x 0). */
  | 'close'
  /** Single window: keep only the focused leaf (C-x 1). */
  | 'single'
  /** Cycle focus to the next leaf (C-x o). */
  | 'other-window'
  /** Open the switch-workspace minibuffer (C-x w). */
  | 'switch-workspace'
  /** Show the previous registry buffer in the focused leaf (C-x ←). */
  | 'previous-buffer'
  /** Show the next registry buffer in the focused leaf (C-x →). */
  | 'next-buffer'
  /** Save: flush the scratch debounce; no-op elsewhere (C-x C-s). */
  | 'save-scratch'
  /** Reset the window layout to the shipped tree (C-x l). */
  | 'reset-layout'
  /** Winner mode: restore the previous window layout (C-c ←). */
  | 'winner-undo'
  /** Winner mode: redo an undone layout (C-c →). */
  | 'winner-redo'
  /** Cancel the pending prefix or an open minibuffer (C-g / Escape). */
  | 'cancel'

/** One parse outcome: arm a prefix, run a command, or nothing. */
export type ChordResult = { prefix: 'x' | 'c' } | { command: WmCommand } | null

/** The armed-prefix state the caller carries between keydowns. */
export type ArmedPrefix = 'x' | 'c' | undefined

/** The parser's view of a keyboard event (structural — testable without DOM). */
export interface KeyEventLike {
  ctrlKey: boolean
  key: string
  altKey?: boolean
  metaKey?: boolean
}

/**
 * Classify one keydown against the chord tables.
 *
 * - Ctrl+X / Ctrl+C arm their prefix: `{ prefix: 'x' | 'c' }`.
 * - With C-x armed, the next key completes: plain b/d/k/o/w/0/1/2/3,
 *   ArrowLeft/ArrowRight (buffer cycling), and ctrl-chorded f/s
 *   (C-x C-f find-file, C-x C-s save). C-x C-g cancels.
 * - With C-c armed, ArrowLeft/ArrowRight run winner undo/redo.
 * - Ctrl+G and Escape cancel any pending prefix or minibuffer from anywhere.
 * - Anything else is `null`; a `null` while a prefix is armed means the
 *   chord failed and the caller must disarm.
 * @param event - the keydown's modifier/key facts.
 * @param prefix - the currently armed prefix, if any.
 * @returns the parse outcome.
 */
export function parseChord(event: KeyEventLike, prefix: ArmedPrefix): ChordResult {
  // Meta/alt-chorded keys are other apps' shortcuts; never intercept.
  if (event.metaKey || event.altKey) return null
  const key = event.key
  if (event.ctrlKey) {
    if (key === 'g' || key === 'G') return { command: 'cancel' }
    if (key === 'x' || key === 'X') return { prefix: 'x' }
    if (key === 'c' || key === 'C') return { prefix: 'c' }
    if (prefix === 'x') {
      if (key === 'f' || key === 'F') return { command: 'find-file' }
      if (key === 's' || key === 'S') return { command: 'save-scratch' }
    }
    return null
  }
  if (key === 'Escape') return { command: 'cancel' }
  if (prefix === undefined) return null
  switch (key) {
    case 'b': return prefix === 'x' ? { command: 'switch-buffer' } : null
    case 'w': return prefix === 'x' ? { command: 'switch-workspace' } : null
    case 'd': return prefix === 'x' ? { command: 'dired' } : null
    case 'k': return prefix === 'x' ? { command: 'kill-buffer' } : null
    case 'l': return prefix === 'x' ? { command: 'reset-layout' } : null
    case 'o': return prefix === 'x' ? { command: 'other-window' } : null
    case '0': return prefix === 'x' ? { command: 'close' } : null
    case '1': return prefix === 'x' ? { command: 'single' } : null
    case '2': return prefix === 'x' ? { command: 'split-below' } : null
    case '3': return prefix === 'x' ? { command: 'split-right' } : null
    case 'ArrowLeft': return { command: prefix === 'x' ? 'previous-buffer' : 'winner-undo' }
    case 'ArrowRight': return { command: prefix === 'x' ? 'next-buffer' : 'winner-redo' }
    default: return null
  }
}
