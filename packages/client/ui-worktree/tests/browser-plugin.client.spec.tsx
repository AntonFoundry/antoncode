// @vitest-environment jsdom
/**
 * ui-worktree browser half on a real cordis Context with fake slots/locale/
 * workspaces faces: the plugin registers the workspace-mode select at
 * conversation.input.left (the composer tool row) and the repo-status chip at
 * conversation.session.header.actions, the inject faces delegate to the
 * workspaces domain, and registration disposal rides the plugin fiber (HMR
 * safety). The node half is exercised over the same Context.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { WorktreeModePrefView } from '@deepseek-ai/dsh-api-workspace-controller/worktree-types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(async () => {
  vi.restoreAllMocks()
})

/** Boot the plugin over fake faces; the workspaces stub records every action. */
async function bench() {
  const ctx = new Context()
  const calls: { method: string; args: unknown[] }[] = []
  const workspaces = {
    setWorktreePref: async (repoPath: string, pref: WorktreeModePrefView) => {
      calls.push({ method: 'setWorktreePref', args: [repoPath, pref] })
    },
    refreshWorktrees: async () => {
      calls.push({ method: 'refreshWorktrees', args: [] })
    },
    worktreeStatus: async (path: string, signal?: AbortSignal) => {
      calls.push({ method: 'worktreeStatus', args: [path, signal] })
      return { path, branch: 'main', head: 't', dirty: false, stashCount: 0, ahead: 0, behind: 0, bases: ['HEAD'] }
    },
  }
  ctx.provide('workspaces', workspaces)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root', children: {
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    ctx,
    fiber,
    calls,
    selectEntry: () => ctx.slots.entries('conversation.input.left').find(e => e.options.id === 'composer-context-bar'),
    chipEntry: () => ctx.slots.entries('conversation.session.header.actions')[0],
  }
}

describe('ui-worktree browser plugin', () => {
  it('registers the mode select and the status chip with negative header order', async () => {
    const b = await bench()
    expect(b.selectEntry()?.options).toMatchObject({ id: 'composer-context-bar', order: 10 })
    expect(b.selectEntry()?.locale).toBe('worktree')
    expect(b.selectEntry()?.inject).toBeTypeOf('function')
    expect(b.chipEntry()?.options).toMatchObject({ id: 'repo-status', order: -20 })
    expect(b.chipEntry()?.locale).toBe('worktree')
    expect(b.chipEntry()?.inject).toBeTypeOf('function')
    // The dictionaries landed under the worktree namespace (the default
    // locale in tests is English).
    expect(b.ctx.locale.bind('worktree')('mode.new')).toBe('New worktree (next session)')
  })

  it('inject faces delegate to the workspaces domain', async () => {
    const b = await bench()
    const selectActions = (b.selectEntry()?.inject as () => {
      setMode: (p: string, m: WorktreeModePrefView) => Promise<void>
      refresh: () => void
    })()
    await selectActions.setMode('/r', { mode: 'new' })
    selectActions.refresh()
    await Promise.resolve()
    const chipActions = (b.chipEntry()?.inject as () => Record<string, unknown>)()
    const status = chipActions.status as (path: string) => Promise<unknown>
    await status('/r')
    expect(b.calls.map(call => call.method)).toEqual(['setWorktreePref', 'refreshWorktrees', 'worktreeStatus'])
  })

  it('both registrations leave with the plugin fiber', async () => {
    const b = await bench()
    await b.fiber.dispose()
    expect(b.selectEntry()).toBeUndefined()
    expect(b.chipEntry()).toBeUndefined()
  })

  it('a failed projection refresh is swallowed by the select entry', async () => {
    const ctx = new Context()
    const workspaces = {
      setWorktreePref: async () => {},
      refreshWorktrees: async () => { throw new Error('wire down') },
      worktreeStatus: async () => { throw new Error('unused') },
    }
    ctx.provide('workspaces', workspaces)
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root', children: { 'conversation.input.left': { kind: 'list', scope: 'session' } },
    } as never, (() => null) as never)
    ctx.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const selectActions = (ctx.slots.entries('conversation.input.left')[0]?.inject as () => { refresh: () => void })()
    expect(() => { selectActions.refresh() }).not.toThrow()
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    await fiber.dispose()
  })
})

describe('ui-worktree node half', () => {
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

})
