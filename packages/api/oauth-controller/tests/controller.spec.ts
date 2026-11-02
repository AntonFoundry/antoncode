/** The Models Remote delegates login progress without exposing credential material. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import OAuthController from '../src/index.ts'

describe('OAuthController', () => {
  it('delegates both login flows and reports unknown attempts', async () => {
    const ctx = new Context()
    const opencode = {
      start: vi.fn(async () => ({ loginId: 'open-1', status: 'pending' as const, userCode: 'ABCD' })),
      snapshot: vi.fn(() => ({ loginId: 'open-1', status: 'awaiting-org' as const, orgs: [{ id: 'org', name: 'Org' }] })),
      select: vi.fn(async () => ({ loginId: 'open-1', status: 'done' as const })),
      cancel: vi.fn(() => ({ loginId: 'open-1', status: 'cancelled' as const })),
    }
    const claude = {
      start: vi.fn(() => ({ loginId: 'claude-1', status: 'pending' as const, verificationUri: 'https://example.test/login' })),
      submit: vi.fn(async () => ({ loginId: 'claude-1', status: 'done' as const })),
      cancel: vi.fn(() => ({ loginId: 'claude-1', status: 'cancelled' as const })),
    }
    ctx.provide('opencodeOAuth', opencode as never)
    ctx.provide('claudeOAuth', claude as never)
    const controller = new OAuthController(ctx)
    expect(await controller.startOpencode()).toMatchObject({ userCode: 'ABCD' })
    expect(controller.statusOpencode('open-1')).toMatchObject({ orgs: [{ id: 'org' }] })
    expect(await controller.selectOpencode('open-1', 'org')).toMatchObject({ status: 'done' })
    expect(opencode.select).toHaveBeenCalledWith('open-1', 'org')
    expect(controller.cancelOpencode('open-1')).toMatchObject({ status: 'cancelled' })
    expect(controller.startClaude()).toMatchObject({ verificationUri: 'https://example.test/login' })
    expect(await controller.submitClaude('claude-1', 'code#state')).toMatchObject({ status: 'done' })
    expect(claude.submit).toHaveBeenCalledWith('claude-1', 'code#state')
    expect(controller.cancelClaude('claude-1')).toMatchObject({ status: 'cancelled' })
    opencode.snapshot.mockReturnValueOnce(undefined as never)
    expect(() => controller.statusOpencode('gone')).toThrow('no longer exists')
    await ctx.fiber.dispose()
  })

  it('reports an unavailable Host login flow', async () => {
    const ctx = new Context()
    const controller = new OAuthController(ctx)
    await expect(controller.startOpencode()).rejects.toThrow('unavailable')
    expect(() => controller.startClaude()).toThrow('unavailable')
    await ctx.fiber.dispose()
  })
})
