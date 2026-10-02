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
  preference: 'system', uiFamily: 'system', uiSize: 14, chatSize: 16,
  monoFont: 'monaco', monoSize: 15, termSize: 13,
}

const VARS = ['--dsw-font-family', '--dsh-zoom-ui', '--dsh-zoom-chat', '--ds-font-family-code', '--dsw-font-size-code', '--dsh-font-size-term'] as const

function clearVars(): void {
  for (const name of VARS) document.documentElement.style.removeProperty(name)
}

afterEach(clearVars)

describe('applyFontVars', () => {
  it('writes all six custom properties on the document root', () => {
    applyFontVars({ ...DEFAULT_SELECTION, uiFamily: 'Avenir Next', uiSize: 14, chatSize: 20 })
    const style = document.documentElement.style
    expect(style.getPropertyValue('--dsw-font-family')).toContain("'Avenir Next'")
    // Zoom is the implementation of the px sizes: uiSize/14, and the chat
    // pane consumes the chat/ui ratio so sections stay independent.
    expect(style.getPropertyValue('--dsh-zoom-ui')).toBe('1')
    expect(style.getPropertyValue('--dsh-zoom-chat')).toBe(String((20 / 16)))
    expect(style.getPropertyValue('--ds-font-family-code')).toContain('Monaco')
    expect(style.getPropertyValue('--dsw-font-size-code')).toBe('15px')
    expect(style.getPropertyValue('--dsh-font-size-term')).toBe('13px')
  })

  it('falls back to the system stack for the system family and unknown ids', () => {
    applyFontVars({ ...DEFAULT_SELECTION, uiFamily: 'system', monoFont: 'not-a-font' })
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
    runtime.setUiFamily('Georgia')
    expect(host.set).toHaveBeenCalledWith('uiFamily', 'Georgia')
    expect(document.documentElement.style.getPropertyValue('--dsw-font-family')).toContain("'Georgia'")
    expect(seen).toHaveBeenCalledWith({ ...DEFAULT_SELECTION, uiFamily: 'Georgia', revision: 1 })
    // Same-id write is a no-op.
    runtime.setUiFamily('Georgia')
    expect(seen).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('setUiSize/setChatSize validate the range and compensate the chat zoom var', async () => {
    const ctx = new Context()
    const host = scopeOf(BASE_SECTION)
    const runtime = new FontRuntime(ctx, host)
    runtime.setUiSize(17)
    expect(host.set).toHaveBeenCalledWith('uiSize', 17)
    expect(document.documentElement.style.getPropertyValue('--dsh-zoom-ui')).toBe(String(17 / 14))
    runtime.setChatSize(20)
    // chat zoom var = (20/16)/(17/14) so the pane renders 20px text while
    // the frame renders 17px-equivalent UI.
    expect(document.documentElement.style.getPropertyValue('--dsh-zoom-chat'))
      .toBe(String((20 / 16) / (17 / 14)))
    expect(() => runtime.setUiSize(11)).toThrow('outside [12, 20]')
    expect(() => runtime.setUiSize(21)).toThrow('outside [12, 20]')
    expect(() => runtime.setUiSize(13.5)).toThrow('outside [12, 20]')
    expect(() => runtime.setChatSize(11)).toThrow('outside [12, 22]')
    expect(() => runtime.setChatSize(23)).toThrow('outside [12, 22]')
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
      ...BASE_SECTION, uiFamily: 'Helvetica Neue', uiSize: 13, chatSize: 18,
      monoFont: 'sf-mono', monoSize: 12, termSize: 16,
    })
    const runtime = new FontRuntime(ctx, host)
    const expected: FontSelection = {
      uiFamily: 'Helvetica Neue', uiSize: 13, chatSize: 18,
      monoFont: 'sf-mono', monoSize: 12, termSize: 16,
    }
    expect(runtime.getFont()).toEqual({ ...expected, revision: 1 })
    expect(document.documentElement.style.getPropertyValue('--dsw-font-size-code')).toBe('12px')
    expect(host.set).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
