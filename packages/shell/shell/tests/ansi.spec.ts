// stripAnsi: model-facing output stays clean when the executor preserved
// ANSI bytes for terminal presentation. CSI/OSC/DCS/two-byte families and
// the unterminated-tail drop are the contract; plain text is untouched.

import { describe, expect, it } from 'vitest'
import { stripAnsi } from '../src/ansi.ts'

const ESC = '\x1b'

describe('stripAnsi: plain text is untouched', () => {
  it('returns text without escapes verbatim', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })

  it('keeps empty and whitespace-only strings', () => {
    expect(stripAnsi('')).toBe('')
    expect(stripAnsi('  \n\t x')).toBe('  \n\t x')
  })

  it('keeps carriage returns and backspaces (display concerns, not escapes)', () => {
    expect(stripAnsi('a\rb')).toBe('a\rb')
    expect(stripAnsi(`ab${'\b'}c`)).toBe(`ab${'\b'}c`)
  })
})

describe('stripAnsi: CSI sequences', () => {
  it('strips SGR color runs, leaving the styled text', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m plain`)).toBe('red plain')
  })

  it('strips combined and 256-color/truecolor SGR', () => {
    expect(stripAnsi(`${ESC}[1;32mbold${ESC}[38;5;208mx${ESC}[38;2;1;2;3my${ESC}[m`)).toBe('boldxy')
  })

  it('strips cursor movement and erase sequences between text', () => {
    expect(stripAnsi(`a${ESC}[2K${ESC}[1G${ESC}[0Jb`)).toBe('ab')
  })

  it('strips CSI with private-parameter prefixes', () => {
    expect(stripAnsi(`${ESC}[?25lh${ESC}[?25l`)).toBe('h')
  })
})

describe('stripAnsi: OSC, DCS, and two-byte escapes', () => {
  it('strips BEL-terminated OSC titles', () => {
    expect(stripAnsi(`${ESC}]0;title\x07ok`)).toBe('ok')
  })

  it('strips ST-terminated OSC (hyperlink)', () => {
    expect(stripAnsi(`${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link')
  })

  it('strips DCS payloads through their string terminator', () => {
    expect(stripAnsi(`${ESC}P1$r${ESC}\\after`)).toBe('after')
  })

  it('strips two-byte escapes (save/restore cursor)', () => {
    expect(stripAnsi(`a${ESC}7${ESC}8b`)).toBe('ab')
  })

  it('drops an unterminated trailing escape and everything after it', () => {
    expect(stripAnsi(`ok${ESC}]0;cut-off`)).toBe('ok')
    expect(stripAnsi(`ok${ESC}[31`)).toBe('ok')
  })
})

describe('stripAnsi: realistic captured output', () => {
  it('cleans a colored git status line', () => {
    const colored = `${ESC}[32mA${ESC}[m  note.md\n ${ESC}[31mM${ESC}[m AGENTS.md\n`
    expect(stripAnsi(colored)).toBe('A  note.md\n M AGENTS.md\n')
  })

  it('keeps text on both sides of an escape on one line', () => {
    expect(stripAnsi(`${ESC}[32mdone${ESC}[39m: ok`)).toBe('done: ok')
  })
})
