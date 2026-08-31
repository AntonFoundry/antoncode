/**
 * Pure chord-parser spec (keymap.ts): the C-x prefix arm, every bound chord
 * completion, the C-g/Escape cancel, and the non-chord fallthroughs. No DOM:
 * the input-target guard is WmFrame's concern, not the parser's.
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
  it('arms the prefix on Ctrl+X with or without a pending prefix', () => {
    expect(parseChord(ev('x', { ctrl: true }), false)).toEqual({ prefix: true })
    expect(parseChord(ev('x', { ctrl: true }), true)).toEqual({ prefix: true })
    expect(parseChord(ev('X', { ctrl: true }), false)).toEqual({ prefix: true })
  })

  it('binds each completion only while the prefix is armed', () => {
    const armed = true
    expect(parseChord(ev('b'), armed)).toEqual({ command: 'switch-buffer' })
    expect(parseChord(ev('w'), armed)).toEqual({ command: 'switch-workspace' })
    expect(parseChord(ev('o'), armed)).toEqual({ command: 'other-window' })
    expect(parseChord(ev('0'), armed)).toEqual({ command: 'close' })
    expect(parseChord(ev('1'), armed)).toEqual({ command: 'single' })
    expect(parseChord(ev('2'), armed)).toEqual({ command: 'split-below' })
    expect(parseChord(ev('3'), armed)).toEqual({ command: 'split-right' })
    // Without the prefix these plain keys are nobody's business.
    for (const key of ['b', 'w', 'o', '0', '1', '2', '3']) {
      expect(parseChord(ev(key), false)).toBeNull()
    }
  })

  it('never binds C-x C-f (save muscle memory stays untouched)', () => {
    expect(parseChord(ev('f', { ctrl: true }), true)).toBeNull()
    expect(parseChord(ev('f'), true)).toBeNull()
  })

  it('cancels on C-g and Escape from any prefix state', () => {
    expect(parseChord(ev('g', { ctrl: true }), true)).toEqual({ command: 'cancel' })
    expect(parseChord(ev('g', { ctrl: true }), false)).toEqual({ command: 'cancel' })
    expect(parseChord(ev('Escape'), true)).toEqual({ command: 'cancel' })
    expect(parseChord(ev('Escape'), false)).toEqual({ command: 'cancel' })
  })

  it('returns null for unbound, modifier-chorded, and multi-char keys', () => {
    expect(parseChord(ev('a'), true)).toBeNull()
    expect(parseChord(ev('ArrowDown'), true)).toBeNull()
    expect(parseChord(ev('c', { meta: true }), false)).toBeNull()
    expect(parseChord(ev('c', { alt: true }), true)).toBeNull()
    expect(parseChord(ev('Enter'), true)).toBeNull()
  })
})
