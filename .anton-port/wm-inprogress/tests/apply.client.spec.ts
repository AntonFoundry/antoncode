// @vitest-environment jsdom
// Client apply wiring under the terminal register form: ctx.layout provided,
// ONE register() call declares the three child slots + seats the store factory
// + wires the panel actions through the inject hook; teardown cascades
// (service unprovided + declarations gone + registration cleared). Node half
// and the invariant companion ride along — one line exposes the aggregate
// coverage gate still requires exercised.

import { Context } from '@deepseek-ai/cordis'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ThemeSettings } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply as themeApply, inject as themeInject, ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply, inject, LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-layout'
import { THEME_STORAGE_KEY } from '@deepseek-ai/dsh-client-ui-layout/src/client/themes.ts'
import * as invariant from '@deepseek-ai/dsh-client-ui-layout/invariant'

beforeEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((node) => { node.remove() })
  document.body.removeAttribute('data-ds-dark-theme')
  document.body.removeAttribute('data-ds-theme')
  document.body.removeAttribute('style')
  window.localStorage.clear()
})

async function bench() {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotRegistry)
  // Theme registers its Appearance settings row and requires the connection
  // seam for persistence; model this bench as a remote, memory-only browser.
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  // ui-theme's Appearance row binds a durable scope through these two.
  ctx.provide('remote', { $on: () => () => {} } as never)
  // One stub per bench, exposed so a test can publish the loaded Host
  // section (ThemeRuntime's adoption input) after boot.
  const host = stubSettingsScope<ThemeSettings>()
  ctx.provide('settingsScope', { bind: () => host.scope } as never)
  // The frame's inject face resolves workspaces/sessions at call time only;
  // the plugin declaration needs the services present.
  ctx.provide('workspaces', {
    list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} },
    startSession: () => {},
  } as never)
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined }), subscribe: () => () => {} },
    open: () => {},
  } as never)
  await ctx.plugin({ inject: themeInject, apply: themeApply }).await()
  await slotsFiber.await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, host }
}

describe('ui-layout client apply', () => {
  it('declares its service dependencies', () => {
    expect(inject).toEqual(['slots', 'theme', 'workspaces', 'sessions', 'connection'])
  })

  it('provides ctx.layout and registers WmFrame into root with the three child declarations', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.get('layout')).toBeInstanceOf(LayoutController)
    // The one register() call occupied 'root'…
    expect(slots.entries('root')).toHaveLength(1)
    // …and declared the children in the ledger.
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('conversation')).toEqual({ kind: 'single', scope: 'session-maybe' })
    expect(slots.spec('details')).toEqual({ kind: 'single', scope: 'session' })
    expect(slots.spec('file.view')).toEqual({ kind: 'keyed', scope: 'root' })
  })

  it('injects the wm hooks source and attaches the panel + wm faces', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const actions = {
      setSidebar: vi.fn(), setDetails: vi.fn(), toggleSidebar: vi.fn(), setNarrow: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn(),
    }
    const injected = (slots.entries('root')[0]!.inject as (actions: never) => object)(actions as never)
    // The injected face: the wm + scratch hooks sources, the write callbacks,
    // and the workspace/host resolvers.
    expect(Object.keys(injected).sort()).toEqual([
      'disposeTerminalSession', 'fetchSessionModel', 'fetchSessionTail', 'hooks', 'interruptSession', 'listDirectory', 'loadTheme', 'mediaUrl', 'openPath', 'openSession', 'openWorkspace', 'previewTheme', 'promptSession', 'readTextFile',
      'rebindPane', 'reconcileBuffers', 'setBuffers', 'setFocus', 'setMode', 'setSidebarBootDropped', 'setSidebarWidth', 'setTree', 'syncStagedSessions', 'themeList', 'writeScratch',
    ])
    expect((injected as { hooks: { wm: unknown; scratch: unknown } }).hooks.wm).toHaveProperty('getSnapshot')
    expect((injected as { hooks: { scratch: unknown } }).hooks.scratch).toHaveProperty('getSnapshot')
    const layout = ctx.get('layout') as LayoutController
    // With the wm face attached, toggleSidebar is a tree operation, not a
    // panel-action forward.
    expect(() => { layout.toggleSidebar() }).not.toThrow()
    expect(actions.toggleSidebar).not.toHaveBeenCalled()
  })

  it('theme presenter applies the initial snapshot, follows theme/change, and unwinds on dispose', async () => {
    const { ctx } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // Initial getter application: jsdom has no matchMedia, system resolves light.
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    const themeColorMeta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    expect(themeColorMeta).not.toBeNull()
    const theme = ctx.get('theme') as ThemeRuntime
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    expect(document.body.getAttribute('data-ds-theme')).toBe('dark')
    expect(document.head.querySelector('meta[name="theme-color"]')).toBe(themeColorMeta)
    await fiber.dispose()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    expect(themeColorMeta?.isConnected).toBe(false)
    // Listener is off: further theme changes no longer reach the document.
    theme.setTheme('light')
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
  })

  it('boots the Aqua default under a system preference; a stored palette id wins', async () => {
    // Fresh boot: no stored id, and the stubbed scope leaves the default
    // `system` preference (jsdom has no matchMedia, so system resolves light)
    // — the Aqua default applies without being persisted.
    const fresh = await bench()
    const fiber = fresh.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(document.body.getAttribute('data-ds-theme')).toBe('macos')
    const theme = fresh.ctx.get('theme') as ThemeRuntime
    expect(theme.getTheme().preference).toBe('macos')
    await fiber.dispose()

    // A persisted load-theme choice beats the default.
    window.localStorage.setItem(THEME_STORAGE_KEY, 'nord')
    const stored = await bench()
    const storedFiber = stored.ctx.plugin({ inject: [...inject], apply })
    await storedFiber.await()
    expect(document.body.getAttribute('data-ds-theme')).toBe('nord')
    await storedFiber.dispose()
  })

  it('a stored palette survives the Host section loading after boot; a built-in choice releases it', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'nord')
    const { ctx, host } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(document.body.getAttribute('data-ds-theme')).toBe('nord')
    // The real scope publishes the loaded section (default `system`) after
    // boot; the palette must ride over it and the stored id must survive —
    // this publish is what used to delete the key and revert the theme. The
    // section carries every schema-resolved field: FontRuntime shares the
    // scope and reads the font fields on the same adoption.
    host.publish({
      status: 'ready',
      value: { preference: 'system', monoFont: 'monaco', monoSize: 15, uiFamily: 'system', uiSize: 14, chatSize: 16, termSize: 13 },
      revision: 1,
      writable: true,
    })
    expect(document.body.getAttribute('data-ds-theme')).toBe('nord')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('nord')
    // An explicit built-in choice (Settings → Appearance) releases the stored
    // palette so it cannot resurrect on the next boot.
    const theme = ctx.get('theme') as ThemeRuntime
    theme.setTheme('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('a persisted built-in preference wins the Aqua boot default restored before the section loads', async () => {
    // Boot race: the shell restores Aqua while the durable read is in flight;
    // when the loaded section names dark, the boot default yields and the
    // presenter applies it — splash dark must not decay into a light app.
    const { ctx, host } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(document.body.getAttribute('data-ds-theme')).toBe('macos')
    host.publish({
      status: 'ready',
      value: { preference: 'dark', monoFont: 'monaco', monoSize: 15, uiFamily: 'system', uiSize: 14, chatSize: 16, termSize: 13 },
      revision: 1,
      writable: true,
    })
    const theme = ctx.get('theme') as ThemeRuntime
    expect(theme.getTheme().preference).toBe('dark')
    expect(document.body.getAttribute('data-ds-theme')).toBe('dark')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    await fiber.dispose()
  })

  it('teardown unwinds the service, the root registration, and the child declarations', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(ctx.get('layout')).toBeUndefined()
    expect(slots.entries('root')).toHaveLength(0)
    expect(slots.spec('sidebar')).toBeUndefined()
    // The built-in root declaration survives entry teardown (runtime-owned).
    expect(slots.spec('root')).toEqual({ kind: 'single', scope: 'root' })
  })
})

describe('node half + invariant companion', () => {
  it('node apply is an intentional no-op (loader-managed lifecycle only)', () => {
    nodeApply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })

  it('invariant companion registers under the package name', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    const ctx = { invariants: { register } } as never
    // The /invariant subpath types live in lib/types (build product); assert
    // the API so the call stays typed where lint runs without a build.
    const dispose = await (invariant as { apply: (ctx: never) => Promise<() => void> }).apply(ctx)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-client-ui-layout', expect.any(Function))
    // The installer is the declared no-op — calling it must not throw.
    expect(() => { (register.mock.calls[0]![1] as (c: never) => void)(undefined as never) }).not.toThrow()
    expect(dispose).toBeTypeOf('function')
  })
})
