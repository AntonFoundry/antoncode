import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmAntigravity from '@deepseek-ai/dsh-llm-antigravity'

const NS = settingsNamespace('llm-antigravity')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-antigravity-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function antigravityAccounts(dir: string): Promise<string> {
  const accountsDir = join(dir, '.config', 'opencode')
  await mkdir(accountsDir, { recursive: true })
  const accountsFile = join(accountsDir, 'antigravity-accounts.json')
  await writeFile(
    accountsFile,
    JSON.stringify({
      version: 1,
      accounts: [
        {
          email: 'test@example.com',
          refreshToken: 'fake-refresh',
          projectId: 'test-project',
          addedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
    { mode: 0o600 },
  )
  return accountsFile
}

async function boot(dir: string, config: LlmAntigravity.Config): Promise<Context> {
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LlmAntigravity, config)
  return ctx
}

describe('request-level dynamic profile for antigravity', () => {
  it('mounts bare and dormant, with the declared route addressed inside the providers dict', async () => {
    const dir = await home()
    const ctx = await boot(dir, {})

    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([
      { provider: 'antigravity', displayName: 'Google Antigravity', settingsNs: 'llm-antigravity', settingsPath: ['providers', 'antigravity'] },
    ])
  })

  it('registers the route when settings supply its profile and returns default models', async () => {
    const dir = await home()
    const accountsFile = await antigravityAccounts(dir)
    const ctx = await boot(dir, {})

    await ctx.settings.update(NS, {
      providers: { antigravity: { accountsPath: accountsFile } },
    })

    expect(ctx.llm.listProviders()).toEqual([{ id: 'antigravity', name: 'Google Antigravity', authConfigured: true }])
    const models = await ctx.llm.listModels('antigravity')
    expect(models.length).toBeGreaterThan(0)
    expect(models.map(m => m.id)).toContain('claude-sonnet-4-6')
    expect(models.map(m => m.id)).toContain('gemini-3.7-flash')
    expect(models.map(m => m.id)).toContain('gemini-3.1-pro')

    // Unset route
    await ctx.settings.mutate(NS, [{ op: 'unset', path: ['providers', 'antigravity'] }])
    expect(ctx.llm.listProviders()).toEqual([])
  })
})
