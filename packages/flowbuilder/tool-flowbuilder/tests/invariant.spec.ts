import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ToolInvariant from '../src/invariant.ts'

describe('tool-flowbuilder invariants', () => {
  it('registers an empty companion (the service owns write-state relations)', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(ToolInvariant)).resolves.toBeDefined()
  })
})
