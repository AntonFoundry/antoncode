/** Stored block generations normalize without exposing retired fields to current writes. */
import { describe, expect, it } from 'vitest'
import { blockLibraryEntrySchema } from '../src/schema.ts'
import { legacyBlockMetadataKey, storedBlockLibraryEntrySchema } from '../src/block-storage.ts'

const block = {
  id: 'b1', name: 'Fetch', kind: 'http', description: '', inputs: [], outputs: [], params: [],
}
const metadata = { createdAt: '2026-01-01T00:00:00.000Z', sourceFlowId: 'flow1' }

describe('stored block metadata', () => {
  it('reads current and legacy fields into one current record', () => {
    const current = { ...block, ...metadata }
    expect(storedBlockLibraryEntrySchema.parse(current)).toEqual(current)
    expect(storedBlockLibraryEntrySchema.parse({ ...block, [legacyBlockMetadataKey]: metadata })).toEqual(current)
    const withoutSource = { createdAt: metadata.createdAt }
    expect(storedBlockLibraryEntrySchema.parse({ ...block, [legacyBlockMetadataKey]: withoutSource }))
      .toEqual({ ...block, ...withoutSource })
  })

  it.each([
    {}, { createdAt: 1 }, { createdAt: metadata.createdAt, sourceFlowId: 1 },
  ])('rejects invalid or absent metadata %j in both stored generations', (invalid) => {
    expect(storedBlockLibraryEntrySchema.safeParse({ ...block, ...invalid }).success).toBe(false)
    expect(storedBlockLibraryEntrySchema.safeParse({ ...block, [legacyBlockMetadataKey]: invalid }).success).toBe(false)
  })

  it('rejects dual metadata rather than falling back from invalid current data', () => {
    for (const current of [metadata, { createdAt: 1 }, { sourceFlowId: 'other' }]) {
      expect(storedBlockLibraryEntrySchema.safeParse({
        ...block, ...current, [legacyBlockMetadataKey]: metadata,
      }).success).toBe(false)
    }
  })

  it('rejects retired fields in the current writer schema', () => {
    expect(blockLibraryEntrySchema.safeParse({ ...block, [legacyBlockMetadataKey]: metadata }).success).toBe(false)
    expect(blockLibraryEntrySchema.safeParse({ ...block, ...metadata, [legacyBlockMetadataKey]: metadata }).success).toBe(false)
    expect(blockLibraryEntrySchema.parse({ ...block, ...metadata })).not.toHaveProperty(legacyBlockMetadataKey)
  })
})
