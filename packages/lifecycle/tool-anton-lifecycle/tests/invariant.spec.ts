/**
 * The invariant companion registers under the owning package's name with an installer whose
 * emptiness is the documented contract (no durable event relation is owned here).
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as Invariant from '../src/invariant.ts'

describe('tool-anton-lifecycle invariant companion', () => {
  it('reserves package ownership under the package name', async () => {
    const registered: [string, unknown][] = []
    const ctx = { invariants: { register: (packageName: string, install: unknown) => { registered.push([packageName, install]); return () => {} } } }
    const dispose = await Invariant.apply(ctx as unknown as Context)
    expect(registered).toEqual([['@deepseek-ai/dsh-tool-anton-lifecycle', expect.any(Function)]])
    expect(typeof dispose).toBe('function')
  })
})
