import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ServiceInvariant from '../src/invariant.ts'
// Type-only: the flowbuilder/* Events augmentation lives in the service module.
import type {} from '../src/service.ts'
import { BlockId, FlowId } from '@deepseek-ai/dsh-flowbuilder-domain'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ServiceInvariant)
  return ctx
}

const flowRecord = {
  id: FlowId('f1'),
  name: 'demo',
  description: '',
  nodes: [],
  edges: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const blockRecord = {
  id: BlockId('b1'),
  name: 'block',
  kind: 'code' as const,
  description: '',
  code: 'return 1',
  inputs: [],
  outputs: [],
  params: [],
  provenance: { createdAt: '2026-01-01T00:00:00.000Z' },
}

describe('flowbuilder-service invariants', () => {
  it('accepts well-formed change events', async () => {
    const ctx = await setup()
    ctx.emit('flowbuilder/flow-changed', 'saved', flowRecord)
    ctx.emit('flowbuilder/flow-changed', 'deleted', flowRecord)
    ctx.emit('flowbuilder/library-changed', 'saved', blockRecord)
    ctx.emit('tools/change')
  })

  it('rejects unknown actions and malformed payloads', async () => {
    const ctx = await setup()
    expect(() => ctx.emit('flowbuilder/flow-changed', 'upserted' as never, flowRecord))
      .toThrow(/unknown action/)
    expect(() => ctx.emit('flowbuilder/flow-changed', 'saved', { ...flowRecord, name: '' }))
      .toThrow(/durable schema/)
    expect(() => ctx.emit('flowbuilder/library-changed', 'saved', { ...blockRecord, provenance: {} as never }))
      .toThrow(/durable schema/)
  })
})
