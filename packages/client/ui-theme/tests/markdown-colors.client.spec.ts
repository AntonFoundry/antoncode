/** Markdown semantic inks follow the syntax palette without recoloring compact prose. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parseRules } from './stylesheet-scan.ts'

const readStyle = (path: string): string => readFileSync(resolve(import.meta.dirname, path), 'utf8')
const themeRules = parseRules(readStyle('../src/styles/design-platform.css'))
const shikiRules = parseRules(readStyle('../src/styles/shiki.css'))
const markdown = readStyle('../../ui-primitives/src/markdown/MarkdownText.module.css')
const markdownRules = parseRules(markdown)
const inks = {
  '--dsw-alias-markdown-heading-primary': '--shiki-token-function',
  '--dsw-alias-markdown-heading-secondary': '--shiki-token-link',
  '--dsw-alias-markdown-emphasis': '--shiki-token-function',
  '--dsw-alias-markdown-code-foreground': '--shiki-token-function',
  '--dsw-alias-markdown-table-heading': '--shiki-token-link',
}
const backgrounds = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3']
const consumers = [
  ['.markdown :where(h1, h2)', '--dsw-alias-markdown-heading-primary'],
  ['.markdown :where(h3, h4, h5, h6)', '--dsw-alias-markdown-heading-secondary'],
  ['.markdown strong', '--dsw-alias-markdown-emphasis'],
  ['.markdown :not(pre) > code', '--dsw-alias-markdown-code-foreground'],
  ['.tableScroll th', '--dsw-alias-markdown-table-heading'],
] as const

type Rgb = [number, number, number]

function palette(dark: boolean): Map<string, string> {
  const rules = [...themeRules, ...shikiRules]
  return new Map([':root', 'body', ...(dark ? ['body[data-ds-dark-theme]'] : [])]
    .flatMap(selector => rules.filter(rule => rule.selectors.includes(selector)).flatMap(rule => rule.declarations)))
}

function color(values: Map<string, string>, name: string, seen = new Set<string>()): Rgb {
  const value = values.get(name)
  if (value === undefined || seen.has(name)) throw new Error(`Unresolved color ${name}`)
  seen.add(name)
  const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)
  if (reference) return color(values, reference[1]!, seen)
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value)
  if (hex) return [Number.parseInt(hex[1]!, 16), Number.parseInt(hex[2]!, 16), Number.parseInt(hex[3]!, 16)]
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  throw new Error(`Unsupported color ${name}: ${value}`)
}

function luminance(rgb: Rgb): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

function colorRule(selector: string): { index: number; value: string | undefined } {
  // parseRules splits commas inside :where/:is too; rejoin those grouped selectors.
  const index = markdownRules.findLastIndex(rule =>
    (rule.selectors.includes(selector) || rule.selectors.join(', ') === selector)
    && rule.declarations.some(([property]) => property === 'color'))
  expect(index, `color rule for ${selector}`).toBeGreaterThanOrEqual(0)
  return { index, value: markdownRules[index]!.declarations.findLast(([property]) => property === 'color')?.[1] }
}

it('pins prose aliases to Shiki tokens on body, where the dark token overrides resolve', () => {
  const body = new Map(shikiRules.filter(rule => rule.selectors.includes('body')).flatMap(rule => rule.declarations))
  for (const [alias, token] of Object.entries(inks)) {
    expect(body.get(alias), alias).toBe(`var(${token})`)
    for (const rule of shikiRules) {
      for (const [property, value] of rule.declarations) {
        if (property !== alias) continue
        expect(rule.selectors, alias).not.toContain(':root')
        expect(value, alias).toBe(`var(${token})`)
      }
    }
  }
})

it.each([false, true])('keeps every prose and table ink at WCAG AA contrast on actual surfaces (dark=%s)', (dark) => {
  const values = palette(dark)
  for (const ink of Object.keys(inks)) {
    const surfaces = ink === '--dsw-alias-markdown-code-foreground'
      ? [...backgrounds, '--dsw-alias-markdown-inline-code']
      : backgrounds
    for (const surface of surfaces) {
      const foreground = luminance(color(values, ink))
      const background = luminance(color(values, surface))
      const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
      expect(contrast, `${ink} on ${surface}, dark=${dark}`).toBeGreaterThanOrEqual(4.5)
    }
  }
})

it('uses semantic aliases rather than Shiki tokens in Markdown consumers', () => {
  expect(markdown).not.toMatch(/--shiki-/)
  for (const [selector, alias] of consumers) expect(colorRule(selector).value, selector).toBe(`var(${alias})`)
})

it('keeps authored link emphasis and inline code in the navigation ink', () => {
  const navigation = colorRule('.markdown a :is(strong, code), .markdown .fileLink :is(strong, code)')
  expect(navigation.value).toBe('inherit')
  for (const selector of ['.markdown strong', '.markdown :not(pre) > code']) {
    expect(navigation.index).toBeGreaterThan(colorRule(selector).index)
  }
})

it('keeps heading strong text in the heading ink and compact descendants in the surrounding ink', () => {
  const headingStrong = colorRule('.markdown :where(h1, h2, h3, h4, h5, h6) strong')
  expect(headingStrong.value).toBe('inherit')
  expect(headingStrong.index).toBeGreaterThan(colorRule('.markdown strong').index)

  const compactHeadings = colorRule('.compact :is(h1, h2, h3, h4, h5, h6)')
  expect(compactHeadings.value).toBe('inherit')
  for (const selector of ['.markdown :where(h1, h2)', '.markdown :where(h3, h4, h5, h6)']) {
    expect(compactHeadings.index).toBeGreaterThan(colorRule(selector).index)
  }
  for (const [compact, normal] of [
    ['.compact strong', '.markdown strong'],
    ['.compact :not(pre) > code', '.markdown :not(pre) > code'],
    ['.compact th', '.tableScroll th'],
  ] as const) {
    const override = colorRule(compact)
    expect(override.value, compact).toBe('inherit')
    expect(override.index, compact).toBeGreaterThan(colorRule(normal).index)
  }
})
