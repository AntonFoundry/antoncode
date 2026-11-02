import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { worktreeStatus } from '../src/git.ts'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { realpathNormalize, WorkspaceId as WorkspaceIdBrand } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorktreeRegistry, {
  GitNotARepositoryError,
  WorktreeId,
  WorktreeUnknownError,
} from '../src/index.ts'
import { worktreeDomainState } from '../src/spec.ts'

const exec = promisify(execFile)

const git = async (repoPath: string, args: string[]): Promise<string> => {
  const { stdout } = await exec('git', args, { cwd: repoPath })
  return stdout.trim()
}

/** One real git repository under a per-test tmp root. */
interface Repo {
  /** Repository root as created. */
  path: string
  /** Canonical path of the repository root. */
  canonical: string
  /** Worktree parent directory this repo's worktrees land in. */
  worktreeParent: string
}

/** Create a real repository with one commit; optionally expose origin/main locally. */
async function makeRepo(root: string, name: string, withOriginMain = true): Promise<Repo> {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  await git(path, ['init', '--initial-branch', 'main'])
  await git(path, ['config', 'user.email', 'test@example.com'])
  await git(path, ['config', 'user.name', 'Test'])
  await writeFile(join(path, 'file.txt'), 'one\n')
  await git(path, ['add', '.'])
  await git(path, ['commit', '--message', 'one'])
  if (withOriginMain) await git(path, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  return {
    path,
    canonical: await realpathNormalize(path),
    worktreeParent: `${await realpathNormalize(path)}.worktrees`,
  }
}

interface Harness {
  ctx: Context
  registry: WorktreeRegistry
  /** Workspace-registry stub recordings: creates then deletes, in call order. */
  workspaceCreates: { path: string; title?: string }[]
  workspaceDeletes: string[]
}

/** Boot the real storage/domain composition over a recording workspace-registry stub. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  const workspaceCreates: { path: string; title?: string }[] = []
  const workspaceDeletes: string[] = []
  let nextWorkspaceId = 0
  ctx.provide('workspaceRegistry', {
    create: async (path: string, title?: string) => {
      workspaceCreates.push({ path, ...(title === undefined ? {} : { title }) })
      return {
        id: WorkspaceIdBrand(`ws-${nextWorkspaceId += 1}`),
        path,
        title: title ?? 'workspace',
        sessionIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    },
    delete: async (id: string) => {
      workspaceDeletes.push(id)
      return true
    },
  } as never)

  await ctx.plugin(WorktreeRegistry, { branchPrefix: 'agent/', parentSuffix: '.worktrees' })
  return { ctx, registry: ctx.worktreeRegistry, workspaceCreates, workspaceDeletes }
}

describe('worktree registry', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-worktree-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('creates a worktree off origin/main, registers its workspace, and persists the record', async () => {
    const repo = await makeRepo(root, 'repo-a')
    const { registry, workspaceCreates } = await harness()
    const record = await registry.create(repo.path, { name: 'Fix Login Flow' })

    expect(record.branch).toBe('agent/fix-login-flow')
    expect(record.base).toBe('origin/main')
    expect(record.path).toBe(join(repo.worktreeParent, 'fix-login-flow'))
    expect(record.repoPath).toBe(repo.canonical)
    // The worktree really checked out the committed content on its own branch.
    expect(await readFile(join(record.path, 'file.txt'), 'utf8')).toBe('one\n')
    expect(await git(record.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('agent/fix-login-flow')
    // The workspace registration recorded the branch title over the worktree path.
    expect(workspaceCreates).toEqual([{ path: record.path, title: 'agent/fix-login-flow' }])
    expect(record.workspaceId).toBe('ws-1')
    // The record is durably listed, newest first.
    const listed = await registry.list(repo.path)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.path).toBe(record.path)
  })

  it('claims the display alias from the first titled session inside the worktree', async () => {
    const repo = await makeRepo(root, 'repo-alias')
    const { registry } = await harness()
    const record = await registry.create(repo.path, {})

    // A session outside any registered worktree claims nothing.
    await registry.aliasFromTitle('s0', join(root, 'elsewhere'), 'Elsewhere Title')
    expect((await registry.list())[0]?.alias).toBeUndefined()

    // The first titled session inside claims the alias; the slug follows the
    // slugify rules (spaces → hyphens, lowercase, punctuation dropped).
    await registry.aliasFromTitle('s1', record.path, 'Fix Compiler Warnings!')
    expect((await registry.list())[0]?.alias).toBe('fix-compiler-warnings')
    expect((await registry.list())[0]?.aliasSessionId).toBe('s1')

    // The claiming session's later titles refine the alias (fallback →
    // provider → user rename), and the slug cap keeps it bounded.
    await registry.aliasFromTitle('s1', record.path, 'Review Compiler Correctness In The Janet Build')
    expect((await registry.list())[0]?.alias).toBe('review-compiler-correctness-in-the-janet')

    // Another session never renames it — a reused worktree keeps the name of
    // the session that first titled it.
    await registry.aliasFromTitle('s2', record.path, 'Hijack')
    expect((await registry.list())[0]?.alias).toBe('review-compiler-correctness-in-the-janet')
  })

  it('ignores title events that claim nothing: empty slugs and no-op repeats', async () => {
    const repo = await makeRepo(root, 'repo-alias-noop')
    const { registry } = await harness()
    const record = await registry.create(repo.path, {})

    await registry.aliasFromTitle('s1', record.path, '!!!')
    expect((await registry.list())[0]?.alias).toBeUndefined()

    await registry.aliasFromTitle('s1', record.path, 'Real Name')
    await registry.aliasFromTitle('s1', record.path, 'Real Name')
    expect((await registry.list())[0]?.alias).toBe('real-name')
  })

  it('falls back to HEAD when no origin/main exists locally', async () => {
    const repo = await makeRepo(root, 'no-origin', false)
    const { registry } = await harness()
    const record = await registry.create(repo.path)
    expect(record.base).toBe('HEAD')
    expect(record.branch).toMatch(/^agent\/wt-\d{8}-\d{6}$/)
  })

  it('uniquifies colliding slugs instead of clobbering an existing worktree', async () => {
    const repo = await makeRepo(root, 'collide')
    const { registry } = await harness()
    const first = await registry.create(repo.path, { name: 'feature' })
    const second = await registry.create(repo.path, { name: 'feature' })
    expect(first.path).toBe(join(repo.worktreeParent, 'feature'))
    expect(second.path).toBe(join(repo.worktreeParent, 'feature-2'))
    expect((await registry.list(repo.path)).map(record => record.path)).toEqual([second.path, first.path])
  })

  it('skips a colliding branch even when its worktree directory is absent', async () => {
    const repo = await makeRepo(root, 'branch-collide')
    await git(repo.path, ['branch', 'agent/feature'])
    const { registry } = await harness()
    const record = await registry.create(repo.path, { name: 'feature' })
    expect(record.branch).toBe('agent/feature-2')
    expect(record.path).toBe(join(repo.worktreeParent, 'feature-2'))
  })

  it('reattaches an existing branch instead of failing, after the worktree directory was removed', async () => {
    const repo = await makeRepo(root, 'stale')
    const { registry } = await harness()
    const first = await registry.create(repo.path, { name: 'rework' })
    await rm(first.path, { recursive: true, force: true })
    const second = await registry.create(repo.path, { name: 'rework' })
    expect(second.branch).toBe('agent/rework')
    expect(second.base).toBe('origin/main')
    expect(await git(second.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('agent/rework')
  })

  it('clears the record of a worktree whose directory was deleted externally', async () => {
    const repo = await makeRepo(root, 'externally-gone')
    const { registry } = await harness()
    const record = await registry.create(repo.path, { name: 'gone' })
    await rm(record.path, { recursive: true, force: true })
    // git refuses a plain remove of the vanished tree; the registry accepts
    // that specific complaint and deletes the stale record.
    await registry.remove(record.id)
    expect(await registry.list(repo.path)).toEqual([])
  })

  it('reduces a punctuation-only name to the fallback slug', async () => {
    const repo = await makeRepo(root, 'slug-fallback')
    const { registry } = await harness()
    const record = await registry.create(repo.path, { name: '!!! ???' })
    expect(record.branch).toBe('agent/wt')
    expect(record.path).toBe(join(repo.worktreeParent, 'wt'))
  })

  it('reports a detached HEAD as a detached branch marker', async () => {
    const repo = await makeRepo(root, 'detached')
    const { registry } = await harness()
    const record = await registry.create(repo.path, { name: 'detached-head' })
    await git(record.path, ['checkout', '--detach', 'HEAD'])
    const status = await registry.status(record.path)
    expect(status.branch).toBe('(detached)')
  })

  it('rejects a caller-supplied base that does not resolve locally', async () => {
    const repo = await makeRepo(root, 'bad-base')
    const { registry } = await harness()
    await expect(registry.create(repo.path, { base: 'refs/heads/nope' })).rejects.toThrow(/unknown base ref/)
    expect(await registry.list(repo.path)).toEqual([])
  })

  it('refuses to create a worktree for a directory outside any repository', async () => {
    const { registry } = await harness()
    const bare = join(root, 'not-a-repo')
    await mkdir(bare)
    await expect(registry.create(bare)).rejects.toThrow(GitNotARepositoryError)
  })

  it('types the not-a-repository failure of any probed subcommand, including the status poll', async () => {
    const bare = join(root, 'status-not-a-repo')
    await mkdir(bare)
    // The worktree-status poll runs `status --porcelain --branch`, not a
    // rev-parse probe; the typed error is what maps to the API's business
    // error instead of a handler 500.
    await expect(worktreeStatus(bare)).rejects.toThrow(GitNotARepositoryError)
  })

  it('filters list() by repository and sorts newest first across repos', async () => {
    const repoA = await makeRepo(root, 'multi-a')
    const repoB = await makeRepo(root, 'multi-b')
    const { registry } = await harness()
    const a1 = await registry.create(repoA.path, { name: 'a-one' })
    const b1 = await registry.create(repoB.path, { name: 'b-one' })
    const a2 = await registry.create(repoA.path, { name: 'a-two' })
    expect((await registry.list(repoA.path)).map(record => record.path)).toEqual([a2.path, a1.path])
    expect((await registry.list(repoB.path)).map(record => record.path)).toEqual([b1.path])
    expect(await registry.list()).toHaveLength(3)
  })

  it('reports live status: branch, dirty flag, and repo-global stash count', async () => {
    const repo = await makeRepo(root, 'status')
    const { registry } = await harness()
    const worktree = await registry.create(repo.path, { name: 'live' })
    const clean = await registry.status(worktree.path)
    expect(clean.branch).toBe('agent/live')
    expect(clean.dirty).toBe(false)
    expect(clean.stashCount).toBe(0)
    expect(clean.ahead).toBe(0)
    expect(clean.behind).toBe(0)

    await writeFile(join(worktree.path, 'file.txt'), 'two\n')
    expect((await registry.status(worktree.path)).dirty).toBe(true)
    await git(worktree.path, ['stash', 'push', '--include-untracked'])
    const stashed = await registry.status(worktree.path)
    expect(stashed.dirty).toBe(false)
    expect(stashed.stashCount).toBe(1)
  })

  it('lists base candidates: remote-tracking refs then HEAD, or HEAD alone without a remote', async () => {
    const repo = await makeRepo(root, 'bases') // withOriginMain default: refs/remotes/origin/main exists
    const { registry } = await harness()
    const withRemote = await registry.status(repo.canonical)
    expect(withRemote.bases).toEqual(['origin/main', 'HEAD'])
    const bare = await makeRepo(root, 'bases-bare', false)
    const withoutRemote = await registry.status(bare.canonical)
    expect(withoutRemote.bases).toEqual(['HEAD'])
    // An origin/HEAD symref does not surface as a bare `origin` candidate, and
    // the conventional defaults sort ahead of the alphabetical tail.
    await git(repo.path, ['update-ref', 'refs/remotes/origin/HEAD', 'HEAD'])
    await git(repo.path, ['update-ref', 'refs/remotes/origin/zeta', 'HEAD'])
    await git(repo.path, ['update-ref', 'refs/remotes/origin/master', 'HEAD'])
    const sorted = await registry.status(repo.canonical)
    expect(sorted.bases).toEqual(['origin/main', 'origin/master', 'origin/zeta', 'HEAD'])
  })

  it('round-trips a base ref stored with the mode preference', async () => {
    const repo = await makeRepo(root, 'pref-base')
    const { registry } = await harness()
    await registry.setPref(repo.canonical, { mode: 'new', base: 'origin/develop' })
    expect((await registry.prefs())[repo.canonical]).toEqual({ mode: 'new', base: 'origin/develop' })
    await registry.setPref(repo.canonical, { mode: 'new' })
    expect((await registry.prefs())[repo.canonical]).toEqual({ mode: 'new' })
  })

  it('reports upstream divergence as zero when no upstream is configured', async () => {
    const repo = await makeRepo(root, 'no-upstream')
    const { registry } = await harness()
    const worktree = await registry.create(repo.path, { name: 'diverge' })
    const status = await registry.status(worktree.path)
    expect(status.ahead).toBe(0)
    expect(status.behind).toBe(0)
  })

  it('stores and reads the per-repository mode preference in isolation', async () => {
    const repoA = await makeRepo(root, 'pref-a')
    const repoB = await makeRepo(root, 'pref-b')
    const { registry } = await harness()
    await registry.create(repoA.path, { name: 'reuse-me' })
    expect(await registry.pref(repoA.path)).toBeUndefined()
    await registry.setPref(repoA.path, { mode: 'new' })
    await registry.setPref(repoB.path, { mode: 'reuse', worktreeId: WorktreeId('wt-x') })
    expect(await registry.pref(repoA.path)).toEqual({ mode: 'new' })
    expect(await registry.pref(repoB.path)).toEqual({ mode: 'reuse', worktreeId: 'wt-x' })
    // The preference resolves through any existing directory inside the
    // repository — here the repo's own worktree.
    const repoWorktree = await registry.list(repoA.path)
    expect(await registry.pref((repoWorktree[0] as { path: string }).path)).toEqual({ mode: 'new' })
  })

  it('removes a clean worktree and its record, refusing dirty trees unless forced', async () => {
    const repo = await makeRepo(root, 'remove')
    const { registry } = await harness()
    await expect(registry.remove(WorktreeId('missing'))).rejects.toThrow(WorktreeUnknownError)

    const clean = await registry.create(repo.path, { name: 'clean' })
    await registry.remove(clean.id)
    expect(await registry.list(repo.path)).toEqual([])
    await expect(stat(clean.path)).rejects.toThrow()

    const dirty = await registry.create(repo.path, { name: 'dirty' })
    await writeFile(join(dirty.path, 'file.txt'), 'changed\n')
    await expect(registry.remove(dirty.id)).rejects.toThrow()
    expect(await registry.list(repo.path)).toHaveLength(1)
    await registry.remove(dirty.id, { force: true })
    expect(await registry.list(repo.path)).toEqual([])
  })

  it('creates the worktree even when its workspace registration fails, without a workspaceId', async () => {
    const repo = await makeRepo(root, 'ws-fail')
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    // Cordis gives every Context a default logger; spy on the warn channel
    // the registry degrades through.
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.provide('workspaceRegistry', {
      create: async () => { throw new Error('registry unavailable') },
      delete: async () => true,
    } as never)
    await ctx.plugin(WorktreeRegistry, { branchPrefix: 'agent/', parentSuffix: '.worktrees' })
    const registry = ctx.worktreeRegistry
    const record = await registry.create(repo.path, { name: 'ungrouped' })
    // The git side committed; only the grouping degraded (warn, no workspaceId).
    expect(record.workspaceId).toBeUndefined()
    expect(record.path).toBe(join(repo.worktreeParent, 'ungrouped'))
    expect(await registry.list(repo.path)).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('workspace registration failed'))
  })

  it('rolls the git worktree and workspace registration back when the durable write fails', async () => {
    const repo = await makeRepo(root, 'rollback')
    const { registry, workspaceDeletes } = await harness()
    const target = registry as unknown as { requireTable: () => unknown }
    vi.spyOn(target, 'requireTable').mockImplementation(() => {
      throw new Error('storage closed')
    })
    await expect(registry.create(repo.path, { name: 'doomed' })).rejects.toThrow(/storage closed/)
    vi.restoreAllMocks()
    // The commit point held: the workspace registration rolled back, the git
    // worktree is gone, and no record survives.
    expect(workspaceDeletes).toEqual(['ws-1'])
    await expect(stat(join(repo.worktreeParent, 'doomed'))).rejects.toThrow()
    expect(await registry.list(repo.path)).toEqual([])
  })
})

describe('worktree registry guards', () => {
  it('rejects reads and writes before the domain starts, with one message naming the lifecycle', async () => {
    const registry = new WorktreeRegistry(new Context(), { branchPrefix: 'agent/', parentSuffix: '.worktrees' })
    // prefs() is the one public read whose first statement is its guard.
    expect(() => registry.prefs()).toThrow('worktree registry is not started yet')
    const guards = registry as unknown as Record<'requireTable' | 'requireGlobal' | 'requireState', () => unknown>
    expect(() => guards.requireTable()).toThrow('worktree registry is not started yet')
    expect(() => guards.requireGlobal()).toThrow('worktree registry is not started yet')
    expect(() => guards.requireState()).toThrow('worktree registry is not started yet')
  })
})

describe('worktree durable schema', () => {
  it('parses durable state and records through the boundary schema, branding ids on the way in', async () => {
    const parsed = worktreeDomainState.parse({
      initialized: true,
      worktreeIds: ['wt-1'],
      prefs: { '/repo': { mode: 'reuse', worktreeId: 'wt-1' } },
    })
    expect(parsed.worktreeIds[0]).toBe('wt-1')
    expect(parsed.prefs['/repo']).toEqual({ mode: 'reuse', worktreeId: 'wt-1' })
    // Defaults fill fields written before they existed.
    expect(worktreeDomainState.parse({}).initialized).toBe(false)
  })
})
