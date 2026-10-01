// @vitest-environment jsdom
/** FontRuntime: defaults, curated writes, durable adoption, and the CSS
 * custom properties it owns on the document root. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { ThemeSettings } from '../src/theme-settings.ts'
import { FontRuntime, applyFontVars } from '../src/client/font-runtime.ts'

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

function clearVars(): void {
  document.documentElement.style.removeProperty('--ds-font-family-code')
  document.documentElement.style.removeProperty('--dsw-font-size-code')
}

afterEach(clearVars)

describe('applyFontVars', () => {
  it('writes both custom properties on the document root', () => {
    applyFontVars({ monoFont: 'menlo', monoSize: 18 })
    const style = document.documentElement.style
    expect(style.getPropertyValue('--ds-font-family-code')).toContain('Menlo')
    expect(style.getPropertyValue('--dsw-font-size-code')).toBe('18px')
  })

  it('falls back to the default stack for unknown ids', () => {
    applyFontVars({ monoFont: 'not-a-font', monoSize: 15 })
    expect(document.documentElement.style.getPropertyValue('--ds-font-family-code'))
      .toContain('Monaco')
  })
})

describe('FontRuntime', () => {
  it('starts at Monaco 15 and applies the vars at construction', () => {
    const ctx = new Context()
    const runtime = new FontRuntime(ctx, scopeOf(undefined))
    expect(runtime.getFont()).toEqual({ monoFont: 'monaco', monoSize: 15, revision: 0 })
    expect(document.documentElement.style.getPropertyValue('--dsw-font-size-code')).toBe('15px')
    void ctx.fiber.dispose()
  })

  it('setMonoFont writes the scope, applies vars, and emits font/change', async () => {
    const ctx = new Context()
    const host = scopeOf({ preference: 'system', monoFont: 'monaco', monoSize: 15 })
    const runtime = new FontRuntime(ctx, host)
    const seen = vi.fn()
    ctx.on('font/change', seen)
    runtime.setMonoFont('jetbrains-mono')
    expect(host.set).toHaveBeenCalledWith('monoFont', 'jetbrains-mono')
    expect(document.documentElement.style.getPropertyValue('--ds-font-family-code'))
      .toContain('JetBrains Mono')
    expect(seen).toHaveBeenCalledWith({ monoFont: 'jetbrains-mono', monoSize: 15, revision: 1 })
    // Same-id write is a no-op.
    runtime.setMonoFont('jetbrains-mono')
    expect(seen).toHaveBeenCalledTimes(1)
    expect(() => runtime.setMonoFont('nope')).toThrow('not curated')
    await ctx.fiber.dispose()
  })

  it('setMonoSize clamps-by-throw and mirrors writes through the scope', async () => {
    const ctx = new Context()
    const host = scopeOf({ preference: 'system', monoFont: 'monaco', monoSize: 15 })
    const runtime = new FontRuntime(ctx, host)
    runtime.setMonoSize(20)
    expect(host.set).toHaveBeenCalledWith('monoSize', 20)
    expect(document.documentElement.style.getPropertyValue('--dsw-font-size-code')).toBe('20px')
    expect(() => runtime.setMonoSize(9)).toThrow('outside')
    expect(() => runtime.setMonoSize(25)).toThrow('outside')
    runtime.setMonoSize(20)
    await ctx.fiber.dispose()
  })

  it('adopts a durable selection pushed through the scope without writing back', async () => {
    const ctx = new Context()
    const host = scopeOf({ preference: 'system', monoFont: 'sf-mono', monoSize: 12 })
    const runtime = new FontRuntime(ctx, host)
    expect(runtime.getFont()).toEqual({ monoFont: 'sf-mono', monoSize: 12, revision: 1 })
    expect(document.documentElement.style.getPropertyValue('--dsw-font-size-code')).toBe('12px')
    expect(host.set).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
