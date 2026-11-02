/**
 * The llm-claude package's invariant companion exposes no independent event
 * sequence; this spec only pins its registration contract.
 */

import { describe, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ClaudeInvariant from '../src/invariant.ts'

describe('llm-claude invariant companion', () => {
  it('registers package ownership with the invariant service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = ctx.plugin(ClaudeInvariant)
    await fiber
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
