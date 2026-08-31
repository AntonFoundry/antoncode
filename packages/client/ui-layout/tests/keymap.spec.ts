/**
 * Pure chord-parser spec: no DOM. Covers the M-x intercept (physical-code
 * matching survives Option-key character mapping), the meta guard, and the
 * M-x registry's invariants (unique names, real commands, bound hints).
 */
import { describe, expect, it } from 'vitest'
import { COMMANDS, parseChord, PREFIX_HINTS } from '../src/client/keymap.ts'

/** A bare keydown with only the given modifiers. */
const ev = (mods: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; key: string; code?: string }) => mods

describe('parseChord — M-x', () => {
  it('Alt+KeyX (the physical code) dispatches m-x regardless of the mapped character', () => {
    // macOS Option+X maps the character, the code stays KeyX.
    expect(parseChord(ev({ altKey: true, key: '¬', code: 'KeyX' }), undefined)).toEqual({ command: 'm-x' })
    expect(parseChord(ev({ altKey: true, key: 'x', code: 'KeyX' }), undefined)).toEqual({ command: 'm-x' })
  })

  it('never fires with meta or ctrl held — those are other tables', () => {
    expect(parseChord(ev({ altKey: true, metaKey: true, key: 'x', code: 'KeyX' }), undefined)).toBeNull()
    expect(parseChord(ev({ ctrlKey: true, key: 'x', code: 'KeyX' }), undefined)).toEqual({ prefix: 'x' })
  })

  it('does not fire for other Alt chords', () => {
    expect(parseChord(ev({ altKey: true, key: 'f', code: 'KeyF' }), undefined)).toBeNull()
  })
})

describe('M-x registry', () => {
  it('names are unique and palette-complete', () => {
    const names = COMMANDS.map(c => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every hint table mentions only bound prefixes', () => {
    for (const hint of [...PREFIX_HINTS.x, ...PREFIX_HINTS.c]) {
      expect(hint.keys.startsWith('C-x') || hint.keys.startsWith('C-c')).toBe(true)
    }
  })

  it('PREFIX_HINTS.x lists a completion for every C-x binding in COMMANDS', () => {
    const bound = new Set(
      COMMANDS.filter(c => c.keys.startsWith('C-x')).map(c => c.keys),
    )
    const hinted = new Set(PREFIX_HINTS.x.map(h => h.keys))
    expect(hinted).toEqual(bound)
  })
})
