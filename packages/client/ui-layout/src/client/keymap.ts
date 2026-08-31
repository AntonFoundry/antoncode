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
  /** Open the M-x extended-command palette over the minibuffer. */
  | 'm-x'
  /** Restart the harness behind the app, then reload the page when it answers. */
  | 'restart-app'

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
  /** The physical key code — M-x detection survives Option-key character mapping. */
  code?: string
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
  // M-x (the extended-command palette): matched on the physical code, so
  // the Option-key character mapping (macOS Option+X types a symbol) cannot
  // hide it. Meta is other apps'; ctrl chords run their own tables.
  if (event.altKey === true && event.ctrlKey !== true && event.metaKey !== true && event.code === 'KeyX') {
    return { command: 'm-x' }
  }
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

/** One entry of the M-x palette: an Emacs-style name, its command id, and its binding. */
export interface CommandEntry {
  /** The palette name (Emacs spelling — this is what M-x completes). */
  name: string
  /** The WmCommand the entry dispatches. */
  command: WmCommand
  /** The keybinding hint shown in the palette and which-key popup. */
  keys: string
}

/** The extended-command registry: one row per window command (compos M-x). */
export const COMMANDS: readonly CommandEntry[] = [
  { name: 'execute-extended-command', command: 'm-x', keys: 'M-x' },
  { name: 'switch-buffer', command: 'switch-buffer', keys: 'C-x b' },
  { name: 'switch-workspace', command: 'switch-workspace', keys: 'C-x w' },
  { name: 'find-file', command: 'find-file', keys: 'C-x C-f' },
  { name: 'dired', command: 'dired', keys: 'C-x d' },
  { name: 'kill-buffer', command: 'kill-buffer', keys: 'C-x k' },
  { name: 'save-scratch', command: 'save-scratch', keys: 'C-x C-s' },
  { name: 'split-below', command: 'split-below', keys: 'C-x 2' },
  { name: 'split-right', command: 'split-right', keys: 'C-x 3' },
  { name: 'delete-window', command: 'close', keys: 'C-x 0' },
  { name: 'delete-other-windows', command: 'single', keys: 'C-x 1' },
  { name: 'other-window', command: 'other-window', keys: 'C-x o' },
  { name: 'previous-buffer', command: 'previous-buffer', keys: 'C-x ←' },
  { name: 'next-buffer', command: 'next-buffer', keys: 'C-x →' },
  { name: 'winner-undo', command: 'winner-undo', keys: 'C-c ←' },
  { name: 'winner-redo', command: 'winner-redo', keys: 'C-c →' },
  { name: 'reset-layout', command: 'reset-layout', keys: 'C-x l' },
  { name: 'keyboard-quit', command: 'cancel', keys: 'C-g' },
  { name: 'restart-app', command: 'restart-app', keys: 'M-x' },
]

/** One which-key row: the keys that complete an armed prefix, and what they do. */
export interface PrefixHint { keys: string; label: string }

/** The which-key table: completions shown while C-x / C-c is armed. */
export const PREFIX_HINTS: Record<'x' | 'c', readonly PrefixHint[]> = {
  x: [
    { keys: 'C-x b', label: 'switch buffer' },
    { keys: 'C-x w', label: 'switch workspace' },
    { keys: 'C-x C-f', label: 'find file' },
    { keys: 'C-x d', label: 'dired' },
    { keys: 'C-x k', label: 'kill buffer' },
    { keys: 'C-x C-s', label: 'save scratch' },
    { keys: 'C-x 2', label: 'split below' },
    { keys: 'C-x 3', label: 'split right' },
    { keys: 'C-x 0', label: 'delete window' },
    { keys: 'C-x 1', label: 'delete other windows' },
    { keys: 'C-x o', label: 'other window' },
    { keys: 'C-x ←', label: 'previous buffer' },
    { keys: 'C-x →', label: 'next buffer' },
    { keys: 'C-x l', label: 'reset layout' },
  ],
  c: [
    { keys: 'C-c ←', label: 'winner undo' },
    { keys: 'C-c →', label: 'winner redo' },
  ],
}
