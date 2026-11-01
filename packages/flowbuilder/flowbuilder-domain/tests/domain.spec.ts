import { describe, expect, it } from 'vitest'
import { flowbuilderDomainSpec } from '../src/spec.ts'


describe('flowbuilderDomainSpec', () => {
  it('declares the three aggregate tables and the bootstrap singleton', () => {
    expect(flowbuilderDomainSpec.name).toBe('flowbuilder')
    expect(Object.keys(flowbuilderDomainSpec.tables).sort()).toEqual(['flows', 'library', 'runs'])
  })
})
