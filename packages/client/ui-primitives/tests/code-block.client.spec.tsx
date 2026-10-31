// @vitest-environment jsdom
// CodeBlock + the shiki singleton: registered grammars highlight into token
// spans colored by --shiki-* custom properties; unknown/absent languages take
// the identical-geometry plain arm; aliases resolve; the trailing newline is
// display-trimmed. MarkdownText's fence route is pinned in markdown.spec.tsx
// alongside the rest of the markdown family.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import { highlightToHtml } from '../src/markdown/highlight.ts'

afterEach(cleanup)

beforeEach(() => {
  vi.useRealTimers()
})

describe('highlightToHtml', () => {
  it('highlights a registered grammar into css-variables token spans', () => {
    const html = highlightToHtml('const x: number = 1', 'typescript')
    expect(html).toContain('pre class="shiki css-variables"')
    expect(html).toContain('var(--shiki-')
  })

  it.each([['ts'], ['js'], ['bash'], ['sh'], ['jsonc']])('resolves the %s alias', (alias) => {
    expect(highlightToHtml('x', alias)).toContain('shiki')
  })

  it('returns undefined for unknown or absent languages', () => {
    expect(highlightToHtml('x', 'invented-lang')).toBeUndefined()
    expect(highlightToHtml('x', undefined)).toBeUndefined()
  })

  it('highlights Janet synchronously through the local grammar', () => {
    const code = '# greet\n(defn greet [name]\n  (print (string "hi, " name)))\n'
    const html = highlightToHtml(code, 'janet')
    expect(html).toContain('pre class="shiki css-variables"')
    expect(html).toContain('var(--shiki-token-comment)')
    expect(html).toContain('var(--shiki-token-string-expression)')
    expect(html).toContain('var(--shiki-token-keyword)')
    expect(html).toContain('var(--shiki-token-function)')
    expect(highlightToHtml('(defn f [] nil)', 'Janet')).toContain('shiki')
  })

  it('highlights Bender synchronously, with its {:hint} contract as a keyword', () => {
    const code = '# hint contract\n(defn add\n  {:hint {:params [:double :double]}}\n  [x y]\n  (+ x y))\n(printf "add = %.1f" (add 20.0 22.0))\n'
    const html = highlightToHtml(code, 'bender')
    expect(html).toContain('pre class="shiki css-variables"')
    expect(html).toContain('var(--shiki-token-comment)')
    expect(html).toContain('var(--shiki-token-string-expression)')
    expect(html).toContain('var(--shiki-token-function)')
    // The fork's own grammar colors `:hint` as a declaration keyword and other
    // keyword literals as values, so the two must not share a token color.
    expect(html).toContain('var(--shiki-token-keyword)">:hint')
    expect(html).toContain('var(--shiki-token-constant)">:params')
    expect(highlightToHtml('(defn f [] nil)', 'BEN')).toContain('shiki')
  })

  // Every read-tool language hint whose grammar loads lazily (the boot set —
  // ts/js/shell/sh/json — is covered above). Touching each one drives its own
  // dynamic import thunk, so the whole LAZY_GRAMMARS table is exercised.
  const LAZY_ALIASES = [
    'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'kotlin', 'swift', 'php',
    'yaml', 'toml', 'ini', 'md', 'mdx', 'html', 'css', 'scss', 'less', 'sql',
    'xml', 'lua',
    // The wider common-language set: one alias per added grammar family, so a
    // regression in any new LAZY_GRAMMARS entry surfaces here.
    'scala', 'dart', 'pl', 'hs', 'ex', 'erl', 'clj', 'rkt', 'scm', 'ml',
    'fs', 'jl', 'm', 'r', 'ps1', 'gradle', 'cmake', 'dockerfile', 'mk',
    'conf', 'diff', 'gql', 'vim', 'zig', 'nim', 'nix', 'sol', 'vue',
    'svelte', 'astro', 'tex', 'properties', 'json5', 'vb', 'coffee', 'reg',
    'proto', 'hcl', 'tf', 'pas', 'http', 'lisp', 'elisp', 'fnl',
    'hy', 'elm', 'crystal', 'fortran', 'cobol', 'ada', 'haxe', 'd', 'purs',
    'gleam', 'gd', 'glsl', 'hlsl', 'wgsl', 'wat', 'verilog', 'v', 'vhdl',
    'asm', 'prolog', 'raku', 'tcl', 'awk', 'bat', 'just', 'cue', 'jsonnet',
    'prisma', 'pug', 'styl', 'sass', 'hbs', 'twig', 'liquid', 'cshtml',
  ]

  it('lazily loads every read-card grammar: plain first, highlighted after load', { timeout: 60_000 }, async () => {
    // First touch returns the plain fallback (undefined) and starts the import.
    for (const alias of LAZY_ALIASES) expect(highlightToHtml('x', alias)).toBeUndefined()
    // Once every grammar has registered, the same call highlights. Sixty-odd
    // dynamic grammar imports can outgrow the default test budget on a loaded
    // machine, so the whole wait carries its own explicit budget.
    await vi.waitFor(() => {
      for (const alias of LAZY_ALIASES) expect(highlightToHtml('x', alias)).toContain('shiki')
    }, { timeout: 55_000 })
  })
})

describe('CodeBlock', () => {
  it('renders the highlighted tree for TypeScript', () => {
    const view = render(<CodeBlock code={'const a = 1\n'} lang="ts" />)
    const pre = view.container.querySelector('pre.shiki')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toBe('const a = 1')
    expect(pre!.querySelectorAll('span[style]').length).toBeGreaterThan(1)
  })

  it('renders the plain arm for an unknown language with the text verbatim', () => {
    const view = render(<CodeBlock code={'IDENTIFICATION DIVISION.'} lang="invented-lang" />)
    expect(view.container.querySelector('pre.shiki')).toBeNull()
    expect(view.getByText('IDENTIFICATION DIVISION.')).toBeTruthy()
  })

  it('renders the plain arm when no language is given', () => {
    const view = render(<CodeBlock code="plain text" />)
    expect(view.container.querySelector('pre.shiki')).toBeNull()
    expect(view.getByText('plain text')).toBeTruthy()
  })

  it('shows the language banner and copies the pre textContent', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<CodeBlock code={'const a = 1\n'} lang="ts" />)
    expect(screen.getByText('ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('const a = 1')
    // Flush the clipboard promise under fake timers before asserting the label.
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '复制成功' })).toBeTruthy()
    // While the ok label is showing, further clicks are no-ops.
    fireEvent.click(screen.getByRole('button', { name: '复制成功' }))
    expect(writeText).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('does not claim success when clipboard.writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<CodeBlock code="plain body" />)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '复制成功' })).toBeNull()
  })

  it('falls back to execCommand when clipboard.writeText is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    const exec = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: exec,
    })
    render(<CodeBlock code="plain body" />)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(exec).toHaveBeenCalledWith('copy')
    expect(await screen.findByRole('button', { name: '复制成功' })).toBeTruthy()
  })

  it('does not claim success when execCommand throws or is absent', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => {
        throw new Error('denied')
      },
    })
    const denied = render(<CodeBlock code="plain body" />)
    fireEvent.click(denied.getByRole('button', { name: '复制' }))
    await Promise.resolve()
    expect(denied.getByRole('button', { name: '复制' })).toBeTruthy()
    denied.unmount()

    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: undefined,
    })
    const absent = render(<CodeBlock code="plain body" />)
    fireEvent.click(absent.getByRole('button', { name: '复制' }))
    await Promise.resolve()
    expect(absent.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(absent.queryByRole('button', { name: '复制成功' })).toBeNull()
  })
})
