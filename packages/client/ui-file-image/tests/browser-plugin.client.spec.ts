/** Browser-half registration: the `image` key installs into the declared file.view slot and leaves with the fiber (HMR safety). */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as nodeApply } from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import { apply, inject } from '../src/client/index.ts'

async function bench() {
  const ctx = new Context()
  const slots = new SlotRegistry(ctx)
  slots.register({ name: 'root', children: { 'file.view': { kind: 'keyed', scope: 'root' } } } as never, () => null)
  return { ctx, slots }
}

describe('ui-file-image client apply', () => {
  it('declares its service dependencies', () => {
    expect(inject).toEqual(['slots'])
  })

  it('registers the image key into file.view and removes it on teardown', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('file.view').map(e => e.options.key)).toEqual(['image'])
    await fiber.dispose()
    expect(slots.entries('file.view')).toHaveLength(0)
  })
})

describe('node half + invariant companion', () => {
  it('node apply is an intentional no-op (slot-only package)', () => {
    nodeApply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })

  it('invariant companion registers under the package name', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    const ctx = { invariants: { register } } as never
    const dispose = await (invariant as { apply: (ctx: never) => Promise<() => void> }).apply(ctx)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-client-ui-file-image', expect.any(Function))
    expect(() => { (register.mock.calls[0]![1] as (c: never) => void)(undefined as never) }).not.toThrow()
    expect(dispose).toBeTypeOf('function')
  })
})
