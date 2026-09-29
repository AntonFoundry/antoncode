/**
 * The flowbuilder domain declaration: record schemas and the `defineDomain`
 * spec the service opens. The zod schemas are the durable-boundary validators
 * and the direct source of the RPC wire projection.
 *
 * @module @deepseek-ai/dsh-flowbuilder-domain/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { FlowId } from './types.ts'
import type { FlowDefinitionRecord, FlowRunRecordRecord } from './schema.ts'
import { blockLibraryEntrySchema, flowDefinitionSchema, flowRunRecordSchema } from './schema.ts'
import type { BlockId } from './types.ts'
import type { BlockLibraryEntryRecord } from './schema.ts'
import type { FlowRunId } from './types.ts'

/**
 * Durable service state singleton. `initialized` distinguishes a valid empty
 * domain from one that has never been opened (the service sets it on first
 * open), mirroring the workspace domain's bootstrap marker.
 */
export const flowbuilderDomainState = z.object({
  initialized: z.boolean(),
})

/** Durable service state inferred from {@link flowbuilderDomainState}. */
export type FlowbuilderDomainState = z.infer<typeof flowbuilderDomainState>

/**
 * The flowbuilder domain spec: one table per aggregate (workflow definitions,
 * the block library, run records) plus the bootstrap singleton. The service
 * opens this through `ctx.storageDomain`; the spec object is the single
 * source of the domain's identity, version, and schemas.
 */
export const flowbuilderDomainSpec = defineDomain({
  name: 'flowbuilder',
  version: 1,
  global: {
    schema: flowbuilderDomainState,
    initial: { initialized: false },
  },
  tables: {
    flows: domainTable<FlowId, FlowDefinitionRecord>(flowDefinitionSchema),
    library: domainTable<BlockId, BlockLibraryEntryRecord>(blockLibraryEntrySchema),
    runs: domainTable<FlowRunId, FlowRunRecordRecord>(flowRunRecordSchema),
  },
})
