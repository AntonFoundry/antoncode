/**
 * Emacs chord parser for the window-manager frame: a pure keydown
 * classifier. The C-x prefix is a state machine ACROSS keypresses, so the
 * caller (WmFrame) carries the armed flag and passes it in; this module
 * stays stateless and DOM-free.
 *
 * Text-safety contract: the INPUT/TARGET guard lives in WmFrame (only the
 * event target knows the element kind), so this parser never sees — and
 * never needs to see — whether typing was in a text field.
 */

/** One window command the chord table binds. */
export type WmCommand =
  /** Open the switch-buffer minibuffer (C-x b). */
  | 'switch-buffer'
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
  /** Cancel the pending prefix or an open minibuffer (C-g / Escape). */
  | 'cancel'

/** One parse outcome: arm the prefix, run a command, or nothing. */
export type ChordResult = { prefix: true } | { command: WmCommand } | null

/** The parser's view of a keyboard event (structural — testable without DOM). */
export interface KeyEventLike {
  ctrlKey: boolean
  key: string
  altKey?: boolean
  metaKey?: boolean
}

/**
 * Classify one keydown against the chord table.
 *
 * - Ctrl+X always (re-)arms the prefix: `{ prefix: true }`.
 * - With the prefix armed, the next PLAIN key completes the chord: b/2/3/0/1/o/w
 *   (C-x C-f is deliberately NOT bound — save muscle memory stays untouched).
 * - Ctrl+G and Escape cancel any pending prefix or minibuffer from anywhere.
 * - Anything else is `null`; a `null` while the prefix is armed means the
 *   chord failed and the caller must disarm.
 * @param event - the keydown's modifier/key facts.
 * @param prefixArmed - whether the C-x prefix is currently pending.
 * @returns the parse outcome.
 */
export function parseChord(event: KeyEventLike, prefixArmed: boolean): ChordResult {
  // Meta/alt-chorded keys are other apps' shortcuts; never intercept.
  if (event.metaKey || event.altKey) return null
  const key = event.key
  if (event.ctrlKey) {
    if (key === 'g' || key === 'G') return { command: 'cancel' }
    if (key === 'x' || key === 'X') return { prefix: true }
    return null
  }
  if (key === 'Escape') return { command: 'cancel' }
  if (!prefixArmed || key.length !== 1) return null
  switch (key) {
    case 'b': return { command: 'switch-buffer' }
    case 'w': return { command: 'switch-workspace' }
    case 'o': return { command: 'other-window' }
    case '0': return { command: 'close' }
    case '1': return { command: 'single' }
    case '2': return { command: 'split-below' }
    case '3': return { command: 'split-right' }
    default: return null
  }
}
