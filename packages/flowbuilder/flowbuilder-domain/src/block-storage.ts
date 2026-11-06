/** Decode stored block records without exposing retired fields to current writers or RPC consumers. */

import { z } from 'zod'
import { blockLibraryEntrySchema } from './schema.ts'

/** Exact v1 stored field name, retained only for reading existing library records. */
export const legacyBlockMetadataKey = 'provenance'

const legacyBlockSchema = blockLibraryEntrySchema.omit({ createdAt: true, sourceFlowId: true }).extend({
  [legacyBlockMetadataKey]: z.object({
    createdAt: z.string(),
    sourceFlowId: z.string().optional(),
  }).strict(),
}).strict().transform((record) => {
  const { [legacyBlockMetadataKey]: metadata, ...block } = record
  return { ...block, ...metadata }
})

/** Read v1 or current stored blocks; mixed or invalid metadata rejects instead of discarding values. */
export const storedBlockLibraryEntrySchema = z.union([blockLibraryEntrySchema, legacyBlockSchema])
