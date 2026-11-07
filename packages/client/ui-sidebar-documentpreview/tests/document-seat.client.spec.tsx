// @vitest-environment jsdom
/** Document extension registration and dispatch through the production Sidebar and Slot renderer. */
import { byteResult } from './fixtures.client.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { RemoteError, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { absoluteFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { apply as resourcesApply, inject as resourcesInject } from '@deepseek-ai/dsh-client-resources/src/client/index.ts'
import { apply as sidebarApply, inject as sidebarInject } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/index.ts'
import { apply, inject } from '../src/client/index.ts'
import type { DocumentPreviewProps } from '../src/client/document/contract.ts'
import type { DocumentLoadMode } from '../src/client/document/registry.ts'
import type { WorkspaceFilesReadRemote } from '../src/client/rpc.ts'
import { PLAIN_BODY_ID } from '../src/client/text/index.ts'

const SESSION = 'documents' as SessionId
const SHORTCUT_CATALOG: readonly never[] = []
let runtime: SlotTestRuntime | undefined
let animations: PropertyDescriptor | undefined

beforeEach(() => {
  animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
})

afterEach(async () => {
  try {
    await runtime?.dispose()
    runtime = undefined
  } finally {
    if (animations === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', animations)
  }
})

async function boot() {
  const rt = await SlotTestRuntime.create()
  rt.ctx.provide('fileDrag', { actions: { prepare: async () => ({ start: () => true, release: () => {} }), reportFailure: () => {} }, read: () => undefined } satisfies import('@deepseek-ai/cordis').Context['fileDrag'])
  runtime = rt
  rt.ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) } } as never)
  rt.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn(), revealRightbar: vi.fn(), panelInfo: rt.panelInfo } as never)
  rt.ctx.provide('shortcuts', { register: () => () => {}, catalog: { getSnapshot: () => SHORTCUT_CATALOG, subscribe: () => () => {} } } as never)
  const locale = new LocaleRuntime(rt.ctx)
  rt.ctx.provide('locale', locale)
  rt.slots.installLocale(locale)
  await rt.declare({
    rightbar: { kind: 'single', scope: 'root' },
    'conversation.session.header.corner': { kind: 'single', scope: 'session' },
  })
  await rt.sessions.add({ id: SESSION })
  await rt.sessions.retainFor(rt.ctx, SESSION, { source: 'mainView' }).ready
  await rt.mount({ inject: [...resourcesInject], apply: resourcesApply })
  const read = vi.fn<WorkspaceFilesReadRemote['workspaceFiles']['read']>().mockImplementation(async (_sessionId, _path, range) => ({
    ok: true,
    value: { absolutePath: '/host/notes', version: 'v1', bytes: 18, offset: range.offset ?? 1, text: range.offset === 3 ? 'third' : 'first\nsecond', lines: range.offset === 3 ? 1 : 2, eof: range.offset === 3 },
  }))
  const bytes = vi.fn(async () => byteResult(new TextEncoder().encode('all')))
  rt.remote.provideNamespaces({ workspaceFiles: { read, readBytes: bytes } })
  rt.ctx.effect(() => rt.ctx.resources.register({
    protocol: 'file',
    open: async function* (_address, { signal }) {
      if (!signal.aborted) yield { ok: true as const, value: { absolutePath: '/host/notes', version: 'v1', bytes: 18 } }
    },
  }))
  await rt.mount({ inject: [...sidebarInject], apply: sidebarApply })
  await rt.mount({ inject: [...inject], apply })
  const view = rt.renderSlot('rightbar', { width: 600, viewportWidth: 1440, canShow: true })
  const open = (name: string): void => {
    act(() => { rt.ctx.sidebarRight.openResource('dsh-resource://file/session/documents/' + name) })
  }
  const register = (id: string, loading: DocumentLoadMode, priority: 'builtin' | 'extension') => rt.ctx.effect(() => {
    const removeDefinition = rt.ctx.documentPreviews.register({ id, extensions: ['md'], priority, title: () => id, loading, wrap: loading === 'text-pages' })
    const removeBody = rt.slots.inject('sidebar.right.tab.document', () => rt.slots.register(
      { name: 'sidebar.right.tab.document', key: id },
      (props: DocumentPreviewProps) => {
        const { tab } = props.useTabInfo()
        const resource = props.useResource<'file'>(props.resourceAddress)
        expect(resource).not.toHaveProperty('operations')
        expect('ctx' in props).toBe(false)
        expect('useDocumentPreview' in props).toBe(false)
        return (
          <div
            data-renderer={id} data-renderer-tab={tab.id}
            data-renderer-path={resource.value?.absolutePath} data-renderer-version={resource.value?.version}
          >
            {props.content.kind === 'text' ? props.content.text : props.content.kind === 'bytes' ? new TextDecoder().decode(props.content.data) : 'renderer'}
          </div>
        )
      },
    ))
    return () => { removeBody(); removeDefinition() }
  })
  return { rt, view, open, register, read, bytes }
}

describe('document extension seat', () => {
  it('keeps different full addresses in separate tabs and reveals the same file without replacing another', async () => {
    const h = await boot()
    h.read.mockImplementation(async (_sessionId, path, range) => ({
      ok: true,
      value: { absolutePath: '/host/' + path, version: 'v1', bytes: path.length, offset: range.offset ?? 1, text: path, lines: 1, eof: true },
    }))
    const firstAddress = sessionFileAddress(SESSION, 'first/notes.unknown')
    const secondAddress = sessionFileAddress(SESSION, 'second/notes.unknown')
    act(() => { h.rt.ctx.sidebarRight.openResource(firstAddress) })
    await waitFor(() => { expect(h.view.container.querySelector('[data-textpreview-line]')?.textContent).toContain('first/notes.unknown') })
    const first = h.rt.ctx.sidebarRight.active()!
    act(() => { h.rt.ctx.sidebarRight.openResource(secondAddress) })
    await waitFor(() => { expect(h.view.container.querySelector('[data-textpreview-line]')?.textContent).toContain('second/notes.unknown') })
    const second = h.rt.ctx.sidebarRight.active()!
    expect(second.id).not.toBe(first.id)
    expect(first.title).toBe(second.title)
    expect(h.rt.ctx.sidebarRight.openTabs.getSnapshot().map(tab => tab.contentId)).toEqual([firstAddress, secondAddress])
    expect(screen.getAllByRole('tab')).toHaveLength(2)

    act(() => { h.rt.ctx.sidebarRight.toggleExpanded() })
    expect(h.rt.ctx.sidebarRight.isExpanded()).toBe(false)
    act(() => { h.rt.ctx.sidebarRight.openResource(firstAddress) })
    await waitFor(() => {
      expect(h.rt.ctx.sidebarRight.isExpanded()).toBe(true)
      expect(h.view.container.querySelector(`[data-dockkit-tab="${first.id}"]`)?.getAttribute('aria-selected')).toBe('true')
      expect(h.view.container.querySelector('[data-textpreview-line]')?.textContent).toContain('first/notes.unknown')
    })
    expect(h.rt.ctx.sidebarRight.active()!.id).toBe(first.id)
    expect(h.rt.ctx.sidebarRight.openTabs.getSnapshot().map(tab => tab.tabId)).toEqual([first.id, second.id])
    expect(h.read.mock.calls.map(([sessionId, path]) => [sessionId, path])).toEqual([
      [SESSION, 'first/notes.unknown'], [SESSION, 'second/notes.unknown'],
    ])

    fireEvent.click(h.view.container.querySelector(`[data-dockkit-tab-close="${first.id}"]`)!)
    expect(h.rt.ctx.sidebarRight.openTabs.getSnapshot().map(tab => tab.tabId)).toEqual([second.id])
    act(() => { h.rt.ctx.sidebarRight.openResource(firstAddress) })
    await waitFor(() => { expect(h.read).toHaveBeenCalledTimes(3) })
    const reopened = h.rt.ctx.sidebarRight.active()!
    expect(reopened.id).not.toBe(first.id)
    expect(reopened.contentId).toBe(firstAddress)
    expect(h.rt.ctx.sidebarRight.openTabs.getSnapshot().map(tab => tab.tabId)).toEqual([second.id, reopened.id])
  })

  it('does not merge the same path addressed through different Sessions', async () => {
    const h = await boot()
    const addresses = [sessionFileAddress('first-session', 'notes.unknown'), sessionFileAddress('second-session', 'notes.unknown')]
    for (const address of addresses) act(() => { h.rt.ctx.sidebarRight.openResource(address) })
    await waitFor(() => { expect(h.read).toHaveBeenCalledTimes(2) })
    expect(h.rt.ctx.sidebarRight.openTabs.getSnapshot().map(tab => tab.contentId)).toEqual(addresses)
    expect(new Set(h.rt.ctx.sidebarRight.openTabs.getSnapshot().map(tab => tab.tabId)).size).toBe(2)
    expect(h.read.mock.calls.map(([sessionId, path]) => [sessionId, path])).toEqual([
      ['first-session', 'notes.unknown'], ['second-session', 'notes.unknown'],
    ])
    act(() => { h.rt.ctx.sidebarRight.openResource(addresses[0]!) })
    expect(h.rt.ctx.sidebarRight.active()!.contentId).toBe(addresses[0])
    expect(h.rt.ctx.sidebarRight.openTabs.getSnapshot()).toHaveLength(2)
    expect(h.read).toHaveBeenCalledTimes(2)
  })

  it('keeps an unsupported binary file in its own tab without reading it', async () => {
    const h = await boot()
    h.open('good.unknown')
    await waitFor(() => { expect(h.read).toHaveBeenCalledOnce() })
    const good = h.rt.ctx.sidebarRight.active()!
    h.open('archive.zip')
    await waitFor(() => { expect(h.view.container.querySelector('[data-textpreview-state="unsupported"]')).not.toBeNull() })
    expect(h.rt.ctx.sidebarRight.active()!.id).not.toBe(good.id)
    expect(h.rt.ctx.sidebarRight.openTabs.getSnapshot()).toHaveLength(2)
    expect(h.read).toHaveBeenCalledOnce()
    expect(h.bytes).not.toHaveBeenCalled()
    fireEvent.click(h.view.container.querySelector(`[data-dockkit-tab="${good.id}"]`)!)
    await waitFor(() => { expect(h.view.container.querySelectorAll('[data-textpreview-line]')).toHaveLength(2) })
    expect(h.view.container.querySelector('[data-textpreview-state="unsupported"]')).toBeNull()
  })

  it.each([
    new RemoteError('workspace-file/not-found', 'Missing file', { path: 'failed.unknown' }),
    new RemoteError('workspace-file/not-text', 'Not text', { path: 'failed.unknown' }),
    new RemoteError('workspace-file/outside-workspace', 'Read refused', { path: 'failed.unknown' }),
    new RemoteError('gateway/internal', 'Connection failed', {}),
  ])(
    'contains $code to its own tab and keeps another file available', async (error) => {
      const h = await boot()
      h.open('good.unknown')
      await waitFor(() => { expect(h.view.container.querySelectorAll('[data-textpreview-line]')).toHaveLength(2) })
      const good = h.rt.ctx.sidebarRight.active()!
      h.read.mockResolvedValueOnce({ ok: false, error })
      h.open('failed.unknown')
      await waitFor(() => { expect(h.view.container.querySelector('[data-textpreview-failed]')?.getAttribute('data-textpreview-failed')).toBe(error.code) })
      const failed = h.rt.ctx.sidebarRight.active()!
      expect(failed.id).not.toBe(good.id)
      expect(h.rt.ctx.sidebarRight.openTabs.getSnapshot()).toHaveLength(2)
      fireEvent.click(h.view.container.querySelector(`[data-dockkit-tab="${good.id}"]`)!)
      await waitFor(() => { expect(h.view.container.querySelectorAll('[data-textpreview-line]')).toHaveLength(2) })
      expect(h.rt.ctx.sidebarRight.active()!.id).toBe(good.id)
      expect(h.view.container.querySelector('[data-textpreview-failed]')).toBeNull()
      expect(h.read).toHaveBeenCalledTimes(2)
      fireEvent.click(h.view.container.querySelector(`[data-dockkit-tab-close="${failed.id}"]`)!)
      expect(h.rt.ctx.sidebarRight.openTabs.getSnapshot().map(tab => tab.tabId)).toEqual([good.id])
    },
  )

  it.each(['notes.unknown', '/other/notes.unknown', 'C:/other/notes.unknown', '//host/share/notes.unknown'])(
    'reads %s through its addressed Session rather than the mounted Tab Session',
    async (path) => {
      const h = await boot()
      act(() => { h.rt.ctx.sidebarRight.openResource(sessionFileAddress('address-session', path)) })
      await waitFor(() => { expect(h.view.container.querySelectorAll('[data-textpreview-line]')).toHaveLength(2) })
      expect(h.read.mock.calls).toEqual([
        ['address-session', path, { offset: 1 }, expect.any(AbortSignal)],
      ])
      expect(h.bytes).not.toHaveBeenCalled()
    },
  )

  it('rejects an unscoped absolute address through candidates before mounting a reader', async () => {
    const h = await boot()
    const address = absoluteFileAddress('/other/notes.unknown')
    expect(h.rt.ctx.sidebarRightTabs.candidates(address)).toEqual([])
    expect(() => {
      act(() => { h.rt.ctx.sidebarRight.openResource(address) })
    }).toThrow('no registered tab type claims')
    expect(() => {
      act(() => { h.rt.ctx.sidebarRight.openResource(address, { kind: 'text' }) })
    }).toThrow('tab type "text" refuses')
    expect(h.read).not.toHaveBeenCalled()
    expect(h.bytes).not.toHaveBeenCalled()
    expect(h.view.container.querySelector('[data-textpreview-state]')).toBeNull()
  })

  it('uses the plain-text body for an unknown extension and loads another page at the scroll edge', async () => {
    const h = await boot()
    h.open('notes.unknown')
    await waitFor(() => { expect(h.view.container.querySelectorAll('[data-textpreview-line]')).toHaveLength(2) })
    expect(h.view.container.querySelector('[data-document-preview]')?.getAttribute('data-document-preview')).toBe(PLAIN_BODY_ID)
    const body = h.view.container.querySelector<HTMLElement>('[data-textpreview-body]')!
    Object.defineProperties(body, { clientHeight: { configurable: true, value: 100 }, scrollHeight: { configurable: true, value: 200 } })
    fireEvent.scroll(body, { target: { scrollTop: 100 } })
    await waitFor(() => { expect(h.view.container.querySelectorAll('[data-textpreview-line]')).toHaveLength(3) })
    expect(h.read.mock.calls.map(([_sessionId, _path, range]) => range.offset)).toEqual([1, 3])
  })

  it('defaults to an extension, switches implementations without changing tabs, and restores a builtin on removal', async () => {
    const h = await boot()
    await act(async () => {
      h.register('builtin-reader', 'text-pages', 'builtin')
      h.register('extension-reader', 'bytes-complete', 'extension')
    })
    h.open('notes.md')
    await waitFor(() => {
      const body = h.view.container.querySelector('[data-renderer="extension-reader"]')
      expect(body?.textContent).toBe('all')
      expect(body?.getAttribute('data-renderer-path')).toBe('/host/notes')
      expect(body?.getAttribute('data-renderer-version')).toBe('v1')
    })
    const tab = h.view.container.querySelector('[data-renderer-tab]')?.getAttribute('data-renderer-tab')
    expect(h.read).not.toHaveBeenCalled()
    expect(h.bytes).toHaveBeenCalledOnce()
    fireEvent.click(h.view.container.querySelector('[data-document-viewer-menu]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'builtin-reader' }))
    await waitFor(() => { expect(h.view.container.querySelector('[data-renderer="builtin-reader"]')?.textContent).toBe('first\nsecond') })
    expect(h.view.container.querySelector('[data-renderer-tab]')?.getAttribute('data-renderer-tab')).toBe(tab)
    await act(async () => { h.register('later-reader', 'text-pages', 'extension') })
    expect(h.view.container.querySelector('[data-renderer="builtin-reader"]')).not.toBeNull()
  })

  it('returns to the matching builtin when the selected implementation is unregistered', async () => {
    const h = await boot()
    let remove: ReturnType<typeof h.register> | undefined
    await act(async () => {
      h.register('builtin-reader', 'text-pages', 'builtin')
      remove = h.register('extension-reader', 'text-pages', 'extension')
    })
    h.open('notes.md')
    await waitFor(() => {
      expect(h.view.container.querySelector('[data-renderer="extension-reader"]')?.getAttribute('data-renderer-version')).toBe('v1')
    })
    await act(async () => { await remove!() })
    await waitFor(() => { expect(h.view.container.querySelector('[data-document-markdown]')).not.toBeNull() })
    expect(h.read).toHaveBeenCalledOnce()
  })
})
