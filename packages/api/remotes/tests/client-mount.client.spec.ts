/** The selected Remote contributions mount together before dependent Client plugins activate. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { apply as gatewayApply, inject as gatewayInject } from '@deepseek-ai/dsh-api-gateway/client'
import { apply as remotesApply } from '../src/client/index.ts'

it('mounts the complete Client Remote assembly, including worktree removal', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(TypertRegistry)
    ctx.provide('connection', {
      interactions: 'none',
      isLoopback: true,
      openWebSocket: () => { throw new Error('unused in mount test') },
      generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
      state: { getSnapshot: () => undefined, subscribe: () => () => {} },
      reconnect: () => {},
      rpc: { call: () => { throw new Error('unused in mount test') } },
      registerGenerationSource: () => () => {},
      start: () => ({ stop: () => {} }),
    } as never)
    await ctx.plugin({ inject: gatewayInject, apply: gatewayApply })
    const dispose = await remotesApply(ctx)
    expect(typeof ctx.remote.worktree.remove).toBe('function')
    expect(typeof ctx.remote.oauth.startClaude).toBe('function')
    await dispose()
    expect(ctx.get('remote.worktree')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
  }
})
