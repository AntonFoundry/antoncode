// @vitest-environment jsdom
/** Exercise the standalone local plugin through its shipped browser module factory. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import * as React from 'react'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

type Dictionary = Record<string, string>
type Translate = (key: string, args?: Record<string, number>) => string
interface Registration { name: string; key?: string; id?: string; label?: () => string }
interface PluginContext {
  effect(callback: () => () => void): void
  slots: {
    inject(name: string, callback: () => () => void): void
    register(options: Registration, component: ComponentType<{ t: Translate }>): () => void
  }
  locale: {
    register(namespace: string, dictionaries: Record<string, Dictionary>): () => void
    bind(namespace: string): Translate
  }
}
interface BrowserModule { factory(require: (id: string) => typeof React): { apply(ctx: PluginContext): void } }
const STORAGE_KEY = '@local/sticky-notes/wall'
const client = readFileSync(resolve(import.meta.dirname, '../../../plugins/sticky-notes/client.js'), 'utf8')

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

function mountPlugin() {
  let module: BrowserModule | undefined
  vm.runInNewContext(client, {
    window: { localStorage: window.localStorage, __ModuleLoader__: { load(value: BrowserModule) { module = value } } },
  })
  if (module === undefined) throw new Error('Client module was not registered')
  const active = new Map<string, ComponentType<{ t: Translate }>>()
  const registrations = new Map<string, Registration>()
  const disposers: (() => void)[] = []
  let dictionary: Dictionary = {}
  const t: Translate = (key, args) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(args?.[name] ?? ''))
  module.factory((id) => { expect(id).toBe('react'); return React }).apply({
    effect(callback) { disposers.push(callback()) },
    locale: {
      register(_namespace, dictionaries) { dictionary = dictionaries.en!; return () => { dictionary = {} } },
      bind() { return t },
    },
    slots: {
      inject(_name, callback) { disposers.push(callback()) },
      register(options, component) {
        active.set(options.name, component); registrations.set(options.name, options)
        return () => { active.delete(options.name); registrations.delete(options.name) }
      },
    },
  })
  const Wall = active.get('main')
  if (Wall === undefined) throw new Error('Wall page was not registered')
  return { Wall, t, active, registrations, dispose() { for (const dispose of disposers.reverse()) dispose() } }
}

describe('opt-in sticky wall', () => {
  it('registers matching sidebar/page keys and removes contributions on disposal', () => {
    const plugin = mountPlugin()
    expect(plugin.registrations.get('main')?.key).toBe('sticky-notes')
    expect(plugin.registrations.get('sidebar.panellist')?.id).toBe('sticky-notes')
    expect(plugin.registrations.get('sidebar.panellist')?.label?.()).toBe('Sticky notes')
    plugin.dispose()
    expect(plugin.active.size).toBe(0)
    expect(plugin.t('title')).toBe('title')
  })

  it('creates, reloads and deletes notes using the same browser store', () => {
    const plugin = mountPlugin()
    const view = render(React.createElement(plugin.Wall, { t: plugin.t }))
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'Keep this idea' } })
    fireEvent.click(view.getByRole('button', { name: 'Stick it' }))
    expect(view.getByText('Keep this idea')).toBeTruthy()
    expect(view.getByRole('textbox').textContent).toBe('')
    view.unmount()
    const reloaded = render(React.createElement(plugin.Wall, { t: plugin.t }))
    expect(reloaded.getByText('Keep this idea')).toBeTruthy()
    fireEvent.click(reloaded.getByRole('button', { name: 'Delete note' }))
    expect(reloaded.queryByText('Keep this idea')).toBeNull()
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual([])
    plugin.dispose()
  })

  it('keeps the draft and existing notes when a write fails', () => {
    const plugin = mountPlugin()
    const view = render(React.createElement(plugin.Wall, { t: plugin.t }))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'Unsaved idea' } })
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter', ctrlKey: true })
    expect((view.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Unsaved idea')
    expect(view.getByRole('status').textContent).toContain('Could not save')
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    plugin.dispose()
  })

  it.each(['not json', '{}', '[{"id":"broken","text":"note"}]'])('does not overwrite unreadable saved data: %s', (raw) => {
    window.localStorage.setItem(STORAGE_KEY, raw)
    const plugin = mountPlugin()
    const view = render(React.createElement(plugin.Wall, { t: plugin.t }))
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'New idea' } })
    expect(view.getByRole('button', { name: 'Stick it' }).hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter', metaKey: true })
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(raw)
    expect(view.getByRole('status').textContent).toContain('could not be read')
    plugin.dispose()
  })
})
