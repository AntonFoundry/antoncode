// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  createClientModuleSystem,
  type ClientBundleRegistration, type ClientModuleLoaderTarget, type WebBootEntry, type WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client'
import type { PropsRenderSlots, ScopedStandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotRegistry } from '../../ui-renderer/src/client/registry.ts'
import { createSlotRenderer } from '../../ui-renderer/src/client/scoped-slots.tsx'
import { LocaleRuntime } from '../../locale/src/client/index.ts'
import { renderSessionArea } from '../../ui-session/src/client/session-provider.tsx'
import * as orchestrator from '../src/client/index.ts'

const ORCHESTRATOR = '@deepseek-ai/dsh-client-ui-orchestrator'
const SERVICES = 'composition-services'
const DECLARATION = 'composition-conversation'
const contexts: Context[] = []

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'composition.orchestrator.frame': { kind: 'single'; scope: 'root' }
  }
}

afterEach(async () => {
  cleanup()
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
    await ctx.fiber.await()
  }
})

function Shell({ renderSlot }: PropsRenderSlots<'composition.orchestrator.frame' | 'shell.overlay'>) {
  return <>{renderSlot('composition.orchestrator.frame', {})}{renderSlot('shell.overlay', {})}</>
}

function Conversation({ renderSlot }: PropsRenderSlots<'conversation.view'>) {
  return <>{renderSlot('conversation.view', {
    inspectCall: undefined, viewRequest: null, openView: () => {}, completeViewRequest: () => {},
  })}</>
}

const sid = (value: string): SessionId => value as SessionId
const ROOT = sid('composition-root')
const CHILD = sid('composition-child')
const summary = (id: SessionId, title: string, fields: Partial<SessionSummary> = {}): SessionSummary => ({
  id, displayTitle: title, retainedBy: {}, updatedAt: 0, running: true, blank: false, ...fields,
})
const workspace = (...sessionIds: SessionId[]): WorkspaceView => ({
  workspaceId: 'composition-workspace' as WorkspaceView['workspaceId'],
  path: '/composition/workspace', title: 'Composition workspace', sessionIds,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
})
const row = (id: string, rev = 'r0'): WebBootEntry => ({
  id, rev, url: `/plugins/??${id}/client.js&rev=${rev}`,
})
const graph = (...entries: WebBootEntry[]): WebBootGraph => ({
  rev: JSON.stringify(entries), entries,
  batches: entries.length === 0 ? [] : [{
    phase: 'application', url: '/composition-batch', rev: 'batch', entries: entries.map(entry => entry.id),
  }],
})

async function composition() {
  const ctx = new Context()
  contexts.push(ctx)
  const sessions = createSnapshotStore<SessionListState>({
    ids: [ROOT], byId: { [ROOT]: summary(ROOT, 'Initial mission') }, phase: 'ready', projectionsBySession: {},
  })
  const workspaces = createSnapshotStore<WorkspaceSnapshot>({
    items: [workspace(ROOT)], archivedSessionIds: [], pinnedSessionIds: [],
    worktrees: { byRepo: {}, prefs: {}, namesByWorkspaceId: {} }, state: 'idle', phase: 'ready', error: null,
  })
  const cancellations: SessionId[] = []
  const operations: Array<{ source: string; signal: AbortSignal }> = []
  const denied = { ok: false as const, error: { code: 'FORBIDDEN', message: 'Cancellation denied by composition policy' } }
  const factories: Record<string, ClientBundleRegistration['factory']> = {
    [ORCHESTRATOR]: () => orchestrator,
    [SERVICES]: () => ({ apply(owner: Context) {
      const slots = new SlotRegistry(owner)
      slots.install(createSlotRenderer())
      const locale = new LocaleRuntime(owner)
      owner.provide('locale', locale)
      slots.installLocale(locale)
      owner.provide('sessions', {
        list: sessions,
        subagentAddress: () => undefined,
        using: async (
          sessionId: SessionId,
          options: { source: string; signal: AbortSignal },
          callback: (reference: { binding: { session: { cancel: () => Promise<typeof denied> } } }) => Promise<void>,
        ) => {
          operations.push(options)
          return callback({ binding: { session: { cancel: async () => {
            cancellations.push(sessionId)
            return denied
          } } } })
        },
      })
      owner.provide('workspaces', { list: workspaces })
      const binding: ScopedStandardSourceBinding = {
        key: ROOT, ctx: owner, hooks: {}, keyedHooks: {}, props: { sessionId: ROOT },
      }
      const scope = createSnapshotStore(binding)
      slots.installScope('session', { current: scope, bindingSource: () => scope, renderArea: renderSessionArea })
      slots.register({ name: 'root', children: {
        'composition.orchestrator.frame': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      } }, Shell)
    } }),
    [DECLARATION]: () => ({ inject: ['slots'], apply(owner: Context) {
      owner.slots.register({ name: 'composition.orchestrator.frame', children: {
        'conversation.view': { kind: 'list', scope: 'session' },
      } }, Conversation)
    } }),
  }
  const initial = graph(row(ORCHESTRATOR), row(SERVICES))
  const fetched: string[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [], load: () => {},
    create: options => createClientModuleSystem(target, { id: 'composition-bootstrap', exports: {} }, options),
  }
  const modules = target.create({
    boot: initial, staticModules: {},
    loadBundle: async (url) => {
      fetched.push(url)
      const ids = url === '/composition-batch'
        ? initial.entries.map(entry => entry.id)
        : [url.split('??')[1]!.split('/client.js')[0]!]
      for (const id of ids) target.load({ id, factory: factories[id]! })
    },
  })
  await ctx.plugin(Loader)
  ctx.loader.internal = modules as never
  await modules.entries.start(ctx.loader, modules.manifest)
  return { ctx, modules, sessions, workspaces, cancellations, operations, fetched }
}

describe('shipped orchestrator composition', () => {
  it('ships one enabled web-app row with an installed package dependency', () => {
    const patch = yaml.load(readFileSync(resolve(import.meta.dirname, '../../../bundle/web-app/cordis.patch.yml'), 'utf8'), {
      schema: yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar' })]),
    }) as Array<{ insert?: Array<{ id: string; name: string; disabled?: unknown }> }>
    const entries = patch.flatMap(operation => operation.insert ?? []).filter(entry => entry.name === ORCHESTRATOR)
    expect(entries).toEqual([{ id: 'ui-orchestrator', name: ORCHESTRATOR }])
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../bundle/web-app/package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(manifest.dependencies[ORCHESTRATOR]).toBe('workspace:*')
    expect('default' in orchestrator).toBe(false)
  })

  it('waits for the view declaration, renders live sources, and reloads without duplicate entries', async () => {
    const b = await composition()
    const slots = b.ctx.slots
    expect(b.modules.entries.state.getSnapshot()).toEqual({ syncing: false, failures: [] })
    expect([...b.ctx.loader.entries()].map(entry => entry.options.name)).toEqual([ORCHESTRATOR, SERVICES])
    expect(slots.spec('conversation.view')).toBeUndefined()
    expect(slots.entries('conversation.view')).toHaveLength(0)
    expect(slots.entries('shell.overlay').map(entry => entry.options.id)).toEqual(['orchestrator-cancellation'])
    render(<>{slots.renderSlot('root', {})}</>)
    expect(screen.queryByText('Initial mission')).toBeNull()

    const roster = (revision = 'r0') => graph(row(ORCHESTRATOR, revision), row(SERVICES), row(DECLARATION))
    await act(async () => { await b.modules.entries.sync(roster()) })
    expect(screen.getByText('Initial mission')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'kill' })).toHaveLength(1)
    const original = slots.entries('conversation.view')[0]!
    expect(original.options).toMatchObject({ id: 'orchestrator', order: 5 })
    expect((original.options.label as () => string)()).toBe('Orchestrator')
    const boardElement = screen.getByText('Initial mission').closest('[data-slot="conversation.view"]')
    expect(boardElement).not.toBeNull()

    await act(async () => {
      b.sessions.update((state) => {
        state.byId[ROOT] = summary(ROOT, 'Renamed mission')
        state.projectionsBySession = {
          [ROOT]: { values: { todos: [{ content: 'Ship live plan', status: 'in_progress' }] }, state: 'ready', error: null },
        }
        state.byId[CHILD] = summary(CHILD, 'Attached worker', { origin: 'subagent', parentId: ROOT })
      })
    })
    expect(screen.queryByText('Initial mission')).toBeNull()
    expect(screen.getByText('Renamed mission')).toBeTruthy()
    expect(screen.getByText('Attached worker')).toBeTruthy()
    expect(screen.getByText('Plan 0/1')).toBeTruthy()
    expect(screen.getByText(/Ship live plan/)).toBeTruthy()
    expect(slots.entries('conversation.view')[0]).toBe(original)
    expect(screen.getByText('Renamed mission').closest('[data-slot="conversation.view"]')).toBe(boardElement)
    await act(async () => {
      b.sessions.update((state) => {
        state.projectionsBySession = {
          [ROOT]: { values: { todos: [{ content: 'Ship live plan', status: 'completed' }] }, state: 'ready', error: null },
        }
      })
    })
    expect(screen.getByText('Plan 1/1')).toBeTruthy()
    expect(slots.entries('conversation.view')[0]).toBe(original)

    const beforeCancel = b.sessions.getSnapshot()
    fireEvent.click(screen.getAllByRole('button', { name: 'kill' })[0]!)
    await waitFor(() => { expect(screen.getByText(/Cancellation denied by composition policy/)).toBeTruthy() })
    expect(b.cancellations).toEqual([ROOT])
    expect(b.operations[0]?.source).toBe('controllerOperation')
    expect(b.sessions.getSnapshot()).toBe(beforeCancel)
    expect(screen.getByText('Renamed mission')).toBeTruthy()

    await act(async () => { b.workspaces.set({ ...b.workspaces.getSnapshot(), archivedSessionIds: [ROOT, CHILD] }) })
    expect(screen.queryByText('Renamed mission')).toBeNull()
    expect(screen.queryByText('Attached worker')).toBeNull()
    await act(async () => { b.workspaces.set({ ...b.workspaces.getSnapshot(), archivedSessionIds: [] }) })
    expect(screen.getByText('Renamed mission')).toBeTruthy()
    await act(async () => { b.sessions.update((state) => { state.byId[ROOT]!.running = false; state.byId[CHILD]!.running = false }) })
    expect(screen.queryByText('Renamed mission')).toBeNull()
    expect(screen.queryByText('Attached worker')).toBeNull()
    await act(async () => { b.sessions.update((state) => { state.byId[ROOT]!.running = true }) })
    expect(screen.getByText('Renamed mission')).toBeTruthy()
    expect(slots.entries('conversation.view')[0]).toBe(original)

    await act(async () => { await b.modules.entries.reload(ORCHESTRATOR, 'r1') })
    expect(b.operations[0]?.signal.aborted).toBe(true)
    expect(slots.entries('conversation.view')).toHaveLength(1)
    expect(slots.entries('conversation.view')[0]).not.toBe(original)
    expect(screen.getAllByText('Renamed mission')).toHaveLength(1)
    expect(screen.queryByText(/Cancellation denied by composition policy/)).toBeNull()
    const reloaded = slots.entries('conversation.view')[0]
    await act(async () => { await b.modules.entries.sync(roster('r1')) })
    expect(slots.entries('conversation.view')[0]).toBe(reloaded)

    await act(async () => { await b.modules.entries.sync(graph(row(ORCHESTRATOR, 'r1'), row(SERVICES))) })
    expect(slots.spec('conversation.view')).toBeUndefined()
    expect(slots.entries('conversation.view')).toHaveLength(0)
    expect(screen.queryByText('Renamed mission')).toBeNull()
    await act(async () => { await b.modules.entries.sync(roster('r1')) })
    expect(slots.entries('conversation.view')).toHaveLength(1)
    expect(screen.getAllByText('Renamed mission')).toHaveLength(1)

    await act(async () => { await b.modules.entries.sync(graph(row(SERVICES), row(DECLARATION))) })
    expect(slots.entries('conversation.view')).toHaveLength(0)
    expect(slots.entries('shell.overlay')).toHaveLength(0)
    expect(screen.queryByText('Renamed mission')).toBeNull()
    await act(async () => { await b.modules.entries.sync(roster('r1')) })
    expect(slots.entries('conversation.view')).toHaveLength(1)
    expect(slots.entries('shell.overlay')).toHaveLength(1)
    expect(screen.getAllByText('Renamed mission')).toHaveLength(1)
    await act(async () => { b.sessions.update((state) => { state.byId[ROOT]!.displayTitle = 'After readd' }) })
    expect(screen.queryByText('Renamed mission')).toBeNull()
    expect(screen.getByText('After readd')).toBeTruthy()
    expect(b.modules.entries.state.getSnapshot()).toEqual({ syncing: false, failures: [] })
    expect(b.fetched.filter(url => url === row(ORCHESTRATOR, 'r1').url)).toHaveLength(2)
  })
})
