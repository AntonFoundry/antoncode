/** Browser-half registration: the `video` key installs into the declared file.view slot and leaves with the fiber (HMR safety). */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as nodeApply } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'

async function bench() {
  const ctx = new Context()
  const slots = new SlotRegistry(ctx)
  slots.register({ name: 'root', children: { 'file.view': { kind: 'keyed', scope: 'root' } } } as never, () => null)
  return { ctx, slots }
}

describe('ui-file-video client apply', () => {
  it('declares its service dependencies', () => {
    expect(inject).toEqual(['slots'])
  })

  it('registers the video key into file.view and removes it on teardown', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('file.view').map(e => e.options.key)).toEqual(['video'])
    await fiber.dispose()
    expect(slots.entries('file.view')).toHaveLength(0)
  })
})

describe('node half', () => {
  it('node apply is an intentional no-op (slot-only package)', () => {
    nodeApply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })

})
