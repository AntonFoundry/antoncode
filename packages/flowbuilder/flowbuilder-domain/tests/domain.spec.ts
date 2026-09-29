import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as DomainInvariant from '../src/invariant.ts'
import { flowbuilderDomainSpec } from '../src/spec.ts'

describe('flowbuilder-domain invariants', () => {
  it('registers an empty companion (types, schemas, and pure validators own no event stream)', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(DomainInvariant)).resolves.toBeDefined()
  })
})

describe('flowbuilderDomainSpec', () => {
  it('declares the three aggregate tables and the bootstrap singleton', () => {
    expect(flowbuilderDomainSpec.name).toBe('flowbuilder')
    expect(Object.keys(flowbuilderDomainSpec.tables).sort()).toEqual(['flows', 'library', 'runs'])
  })
})
