import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_PREFERENCE, THEME_SETTINGS_NAMESPACE, apply,
} from '@deepseek-ai/dsh-client-ui-theme'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('ui-theme host', () => {
  it('registers, validates, and disposes the durable theme namespace with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const ns = settingsNamespace(THEME_SETTINGS_NAMESPACE)
    const defaults = {
      preference: DEFAULT_PREFERENCE, uiFamily: 'system', uiSize: 14, chatSize: 16,
      monoFont: 'monaco', monoSize: 15, termSize: 13,
    }
    expect(ctx.settings.get(ns)).toEqual(defaults)
    await ctx.settings.update(ns, { preference: 'dark' })
    expect(ctx.settings.get(ns)).toEqual({ ...defaults, preference: 'dark' })
    await expect(ctx.settings.update(ns, { preference: 'sepia' })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { monoSize: 99 })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { uiSize: 11 })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { uiSize: 21 })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { chatSize: 11 })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { chatSize: 23 })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { termSize: 25 })).rejects.toThrow()
    await ctx.settings.update(ns, { monoFont: 'menlo', monoSize: 17 })
    expect(ctx.settings.get(ns))
      .toEqual({ ...defaults, preference: 'dark', monoFont: 'menlo', monoSize: 17 })
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })

  it('renders the current durable preference and disposes the index transform', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    let transform: ((html: string) => string) | undefined
    let disposed = false
    ctx.provide('webServer', {
      tapIndex: (next: (html: string) => string) => {
        transform = next
        return () => { disposed = true }
      },
    } as WebServer)
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    expect(transform?.('<body></body>')).toContain('const preference = "system"')
    await ctx.settings.update(settingsNamespace(THEME_SETTINGS_NAMESPACE), { preference: 'dark' })
    expect(transform?.('<body></body>')).toContain('const preference = "dark"')
    await ctx.settings.update(settingsNamespace(THEME_SETTINGS_NAMESPACE), {
      uiFamily: 'Georgia', uiSize: 17, chatSize: 20,
      monoFont: 'menlo', monoSize: 18, termSize: 16,
    })
    const html = transform?.('<body></body>') ?? ''
    expect(html).toContain("root.setProperty('--dsw-font-family'")
    expect(html).toContain("'Georgia'")
    expect(html).toContain(`root.setProperty('--dsh-zoom-ui', "${String(17 / 14)}")`)
    expect(html).toContain(`root.setProperty('--dsh-zoom-chat', "${String((20 / 16) / (17 / 14))}")`)
    expect(html).toContain("root.setProperty('--ds-font-family-code'")
    expect(html).toContain("'Menlo'")
    expect(html).toContain("root.setProperty('--dsw-font-size-code', \"18px\")")
    expect(html).toContain("root.setProperty('--dsh-font-size-term', \"16px\")")
    await fiber.dispose()
    expect(disposed).toBe(true)
    expect(transform?.('<body></body>')).toContain('const preference = "system"')
  })

  it('uses the system preference when only an HTTP server exists', async () => {
    const ctx = new Context()
    let transform: ((html: string) => string) | undefined
    ctx.provide('webServer', {
      tapIndex: (next: (html: string) => string) => {
        transform = next
        return () => undefined
      },
    } as WebServer)
    await ctx.plugin({ apply }).await()
    expect(transform?.('<body></body>')).toContain('const preference = "system"')
  })
})
