// @vitest-environment jsdom
/** FontRuntime: defaults, curated writes, zoom compensation, durable
 * adoption, and the six CSS custom properties it owns on the root. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { ThemeSettings } from '../src/theme-settings.ts'
import { DEFAULT_SELECTION, FontRuntime, applyFontVars, type FontSelection } from '../src/client/font-runtime.ts'

function scopeOf(section: ThemeSettings | undefined): SettingsScope<ThemeSettings> {
  const listeners = new Set<() => void>()
  const snapshot: SettingsScopeSnapshot<ThemeSettings> = {
    status: 'ready', value: section, base: undefined, user: undefined,
    revision: 0, writable: true, mode: 'host',
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: vi.fn(async (field: string, value: unknown) => {
      snapshot.value = { ...(snapshot.value as ThemeSettings), [field]: value } as ThemeSettings
      for (const listener of listeners) listener()
    }),
    unset: vi.fn(async () => {}),
  }
}

const BASE_SECTION: ThemeSettings = {
  preference: 'system', uiFamily: 'system', uiScale: 100, chatScale: 100,
  monoFont: 'monaco', monoSize: 15, termSize: 13,
}

const VARS = ['--dsw-font-family', '--dsh-zoom-ui', '--dsh-zoom-chat', '--ds-font-family-code', '--dsw-font-size-code', '--dsh-font-size-term'] as const

function clearVars(): void {
  for (const name of VARS) document.documentElement.style.removeProperty(name)
}

afterEach(clearVars)

describe('applyFontVars', () => {
  it('writes all six custom properties on the document root', () => {
    applyFontVars({ ...DEFAULT_SELECTION, uiFamily: 'georgia', uiScale: 120, chatScale: 90 })
    const style = document.documentElement.style
    expect(style.getPropertyValue('--dsw-font-family')).toContain('Georgia')
    expect(style.getPropertyValue('--dsh-zoom-ui')).toBe('1.2')
    expect(style.getPropertyValue('--dsh-zoom-chat')).toBe('0.75')
    expect(style.getPropertyValue('--ds-font-family-code')).toContain('Monaco')
    expect(style.getPropertyValue('--dsw-font-size-code')).toBe('15px')
    expect(style.getPropertyValue('--dsh-font-size-term')).toBe('13px')
  })

  it('falls back to the default stacks for unknown family ids', () => {
    applyFontVars({ ...DEFAULT_SELECTION, uiFamily: 'nope', monoFont: 'not-a-font' })
    const style = document.documentElement.style
    expect(style.getPropertyValue('--dsw-font-family')).toContain('-apple-system')
    expect(style.getPropertyValue('--ds-font-family-code')).toContain('Monaco')
  })
})

describe('FontRuntime', () => {
  it('starts at the default selection and applies the vars at construction', () => {
    const ctx = new Context()
    const runtime = new FontRuntime(ctx, scopeOf(undefined))
    expect(runtime.getFont()).toEqual({ ...DEFAULT_SELECTION, revision: 0 })
    expect(document.documentElement.style.getPropertyValue('--dsw-font-size-code')).toBe('15px')
    void ctx.fiber.dispose()
  })

  it('setUiFamily writes the scope, applies vars, and emits font/change', async () => {
    const ctx = new Context()
    const host = scopeOf(BASE_SECTION)
    const runtime = new FontRuntime(ctx, host)
    const seen = vi.fn()
    ctx.on('font/change', seen)
    runtime.setUiFamily('georgia')
    expect(host.set).toHaveBeenCalledWith('uiFamily', 'georgia')
    expect(document.documentElement.style.getPropertyValue('--dsw-font-family')).toContain('Georgia')
    expect(seen).toHaveBeenCalledWith({ ...DEFAULT_SELECTION, uiFamily: 'georgia', revision: 1 })
    // Same-id write is a no-op.
    runtime.setUiFamily('georgia')
    expect(seen).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('setUiScale/setChatScale validate the range and compensate the chat zoom var', async () => {
    const ctx = new Context()
    const host = scopeOf(BASE_SECTION)
    const runtime = new FontRuntime(ctx, host)
    runtime.setUiScale(120)
    expect(host.set).toHaveBeenCalledWith('uiScale', 120)
    expect(document.documentElement.style.getPropertyValue('--dsh-zoom-ui')).toBe('1.2')
    runtime.setChatScale(90)
    // chat zoom var = chat/ui = 0.75 so the two sections stay independent.
    expect(document.documentElement.style.getPropertyValue('--dsh-zoom-chat')).toBe('0.75')
    expect(() => runtime.setUiScale(79)).toThrow('outside [80, 140]')
    expect(() => runtime.setUiScale(141)).toThrow('outside [80, 140]')
    expect(() => runtime.setUiScale(100.5)).toThrow('outside [80, 140]')
    expect(() => runtime.setChatScale(70)).toThrow('outside [80, 140]')
    await ctx.fiber.dispose()
  })

  it('setMonoFont/setMonoSize validate and write the code vars', async () => {
    const ctx = new Context()
    const host = scopeOf(BASE_SECTION)
    const runtime = new FontRuntime(ctx, host)
    runtime.setMonoFont('jetbrains-mono')
    expect(document.documentElement.style.getPropertyValue('--ds-font-family-code'))
      .toContain('JetBrains Mono')
    runtime.setMonoSize(20)
    expect(document.documentElement.style.getPropertyValue('--dsw-font-size-code')).toBe('20px')
    expect(() => runtime.setMonoFont('nope')).toThrow('not curated')
    expect(() => runtime.setMonoSize(9)).toThrow('outside')
    expect(() => runtime.setMonoSize(25)).toThrow('outside')
    await ctx.fiber.dispose()
  })

  it('setTermSize validates and writes the terminal var', async () => {
    const ctx = new Context()
    const host = scopeOf(BASE_SECTION)
    const runtime = new FontRuntime(ctx, host)
    runtime.setTermSize(18)
    expect(host.set).toHaveBeenCalledWith('termSize', 18)
    expect(document.documentElement.style.getPropertyValue('--dsh-font-size-term')).toBe('18px')
    expect(() => runtime.setTermSize(9)).toThrow('outside')
    expect(() => runtime.setTermSize(25)).toThrow('outside')
    await ctx.fiber.dispose()
  })

  it('adopts a durable selection pushed through the scope without writing back', async () => {
    const ctx = new Context()
    const host = scopeOf({
      ...BASE_SECTION, uiFamily: 'helvetica', uiScale: 110, chatScale: 130,
      monoFont: 'sf-mono', monoSize: 12, termSize: 16,
    })
    const runtime = new FontRuntime(ctx, host)
    const expected: FontSelection = {
      uiFamily: 'helvetica', uiScale: 110, chatScale: 130,
      monoFont: 'sf-mono', monoSize: 12, termSize: 16,
    }
    expect(runtime.getFont()).toEqual({ ...expected, revision: 1 })
    expect(document.documentElement.style.getPropertyValue('--dsw-font-size-code')).toBe('12px')
    expect(host.set).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
