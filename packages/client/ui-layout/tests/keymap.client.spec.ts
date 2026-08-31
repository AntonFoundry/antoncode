/**
 * Pure chord-parser spec (keymap.ts): C-x/C-c prefix arming, every bound
 * chord completion, the C-g/Escape cancel, and the non-chord fallthroughs.
 * No DOM: the input-target guard is WmFrame's concern, not the parser's.
 */
import { describe, expect, it } from 'vitest'
import { parseChord } from '../src/client/keymap.ts'

const ev = (key: string, mods: Partial<{ ctrl: boolean; alt: boolean; meta: boolean }> = {}) => ({
  key,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  metaKey: mods.meta ?? false,
})

describe('parseChord', () => {
  it('arms the prefixes on Ctrl+X and Ctrl+C from any state', () => {
    expect(parseChord(ev('x', { ctrl: true }), undefined)).toEqual({ prefix: 'x' })
    expect(parseChord(ev('x', { ctrl: true }), 'x')).toEqual({ prefix: 'x' })
    expect(parseChord(ev('X', { ctrl: true }), 'c')).toEqual({ prefix: 'x' })
    expect(parseChord(ev('c', { ctrl: true }), undefined)).toEqual({ prefix: 'c' })
    expect(parseChord(ev('c', { ctrl: true }), 'x')).toEqual({ prefix: 'c' })
  })

  it('binds each C-x completion only while the x prefix is armed', () => {
    const x = 'x' as const
    expect(parseChord(ev('b'), x)).toEqual({ command: 'switch-buffer' })
    expect(parseChord(ev('w'), x)).toEqual({ command: 'switch-workspace' })
    expect(parseChord(ev('d'), x)).toEqual({ command: 'dired' })
    expect(parseChord(ev('k'), x)).toEqual({ command: 'kill-buffer' })
    expect(parseChord(ev('o'), x)).toEqual({ command: 'other-window' })
    expect(parseChord(ev('0'), x)).toEqual({ command: 'close' })
    expect(parseChord(ev('1'), x)).toEqual({ command: 'single' })
    expect(parseChord(ev('2'), x)).toEqual({ command: 'split-below' })
    expect(parseChord(ev('3'), x)).toEqual({ command: 'split-right' })
    expect(parseChord(ev('ArrowLeft'), x)).toEqual({ command: 'previous-buffer' })
    expect(parseChord(ev('ArrowRight'), x)).toEqual({ command: 'next-buffer' })
    // The ctrl-chorded completions.
    expect(parseChord(ev('f', { ctrl: true }), x)).toEqual({ command: 'find-file' })
    expect(parseChord(ev('s', { ctrl: true }), x)).toEqual({ command: 'save-scratch' })
    // Without the prefix these keys are nobody's business.
    for (const key of ['b', 'w', 'd', 'k', 'o', '0', '1', '2', '3']) {
      expect(parseChord(ev(key), undefined)).toBeNull()
    }
  })

  it('binds winner undo/redo under the C-c prefix', () => {
    const c = 'c' as const
    expect(parseChord(ev('ArrowLeft'), c)).toEqual({ command: 'winner-undo' })
    expect(parseChord(ev('ArrowRight'), c)).toEqual({ command: 'winner-redo' })
    // C-c with a plain key binds nothing (unlike C-x).
    expect(parseChord(ev('b'), c)).toBeNull()
    // Winner chords don't fire under the x prefix.
    expect(parseChord(ev('ArrowLeft'), x0())).toEqual({ command: 'previous-buffer' })
  })

  it('binds C-x C-f (find-file) and never confuses it with save', () => {
    expect(parseChord(ev('f', { ctrl: true }), 'x')).toEqual({ command: 'find-file' })
    expect(parseChord(ev('f', { ctrl: true }), undefined)).toBeNull()
  })

  it('cancels on C-g and Escape from any prefix state', () => {
    expect(parseChord(ev('g', { ctrl: true }), 'x')).toEqual({ command: 'cancel' })
    expect(parseChord(ev('g', { ctrl: true }), 'c')).toEqual({ command: 'cancel' })
    expect(parseChord(ev('g', { ctrl: true }), undefined)).toEqual({ command: 'cancel' })
    expect(parseChord(ev('Escape'), 'x')).toEqual({ command: 'cancel' })
    expect(parseChord(ev('Escape'), undefined)).toEqual({ command: 'cancel' })
  })

  it('returns null for unbound, modifier-chorded, and multi-char keys', () => {
    expect(parseChord(ev('a'), 'x')).toBeNull()
    expect(parseChord(ev('a'), 'c')).toBeNull()
    expect(parseChord(ev('ArrowDown'), 'x')).toBeNull()
    expect(parseChord(ev('c', { meta: true }), undefined)).toBeNull()
    expect(parseChord(ev('x', { alt: true }), undefined)).toBeNull()
    expect(parseChord(ev('Enter'), 'x')).toBeNull()
  })
})

function x0(): 'x' {
  return 'x'
}
