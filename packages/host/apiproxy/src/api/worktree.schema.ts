/**
 * worktree domain zod schemas (names derived from map keys). Brand casts
 * reuse the workspace schema declarations so both sides of the wire share
 * one structural brand story.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { WorktreeId } from './worktree.ts'
import type {
  WorktreeModePrefView, WorktreeStatusView, WorktreeView,
} from './worktree.ts'
import { workspaceIdSchema } from './workspace.schema.ts'

/** WorktreeId: one brand cast after non-empty string validation. */
export const worktreeIdSchema = z.string().min(1) as unknown as z.ZodType<WorktreeId>

/** WorktreeView row of every worktree.* response. */
export const worktreeViewSchema = z.object({
  worktreeId: worktreeIdSchema,
  repoPath: z.string(),
  path: z.string(),
  branch: z.string(),
  base: z.string(),
  workspaceId: workspaceIdSchema.optional(),
  alias: z.string().optional(),
  createdAt: z.string(),
}) satisfies z.ZodType<Wire<WorktreeView>>

/** Live status row of worktree.status. */
export const worktreeStatusViewSchema = z.object({
  path: z.string(),
  branch: z.string(),
  head: z.string(),
  dirty: z.boolean(),
  stashCount: z.number().int().nonnegative(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  bases: z.array(z.string()),
}) satisfies z.ZodType<Wire<WorktreeStatusView>>

/** Per-repo default workspace mode (see {@link WorktreeModePrefView}). */
export const worktreeModePrefSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('checkout'), base: z.string().optional() }),
  z.object({ mode: z.literal('new'), base: z.string().optional() }),
  z.object({ mode: z.literal('reuse'), worktreeId: worktreeIdSchema, base: z.string().optional() }),
]) satisfies z.ZodType<WorktreeModePrefView>

/** worktree.list request payload (repoPath omitted = every repository). */
export const worktreeListRequestSchema = z.object({
  repoPath: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'worktree.list'>>>

/** worktree.list response value. */
export const worktreeListValueSchema = z.object({
  items: z.array(worktreeViewSchema),
  prefs: z.record(z.string(), worktreeModePrefSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'worktree.list'>>>

/** worktree.create request payload: any directory inside the target repository. */
export const worktreeCreateRequestSchema = z.object({
  repoPath: z.string(),
  name: z.string().optional(),
  base: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'worktree.create'>>>

/** worktree.create response value. */
export const worktreeCreateValueSchema = z.object({
  worktree: worktreeViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'worktree.create'>>>

/** worktree.status request payload: any git working directory. */
export const worktreeStatusRequestSchema = z.object({
  path: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'worktree.status'>>>

/** worktree.status response value. */
export const worktreeStatusValueSchema = worktreeStatusViewSchema satisfies z.ZodType<
  Wire<ResponseValue<'worktree.status'>>
>

/** worktree.pref request payload. */
export const worktreePrefRequestSchema = z.object({
  repoPath: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'worktree.pref'>>>

/** worktree.pref response value (pref is null when the repository has none). */
export const worktreePrefValueSchema = z.object({
  pref: worktreeModePrefSchema.nullable(),
}) satisfies z.ZodType<Wire<ResponseValue<'worktree.pref'>>>

/** worktree.setPref request payload. */
export const worktreeSetPrefRequestSchema = z.object({
  repoPath: z.string(),
  pref: worktreeModePrefSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'worktree.setPref'>>>

/** worktree.setPref response value. */
export const worktreeSetPrefValueSchema = z.object({
  saved: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'worktree.setPref'>>>

/** worktree.remove request payload (force removes even a dirty worktree). */
export const worktreeRemoveRequestSchema = z.object({
  worktreeId: worktreeIdSchema,
  force: z.boolean().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'worktree.remove'>>>

/** worktree.remove response value. */
export const worktreeRemoveValueSchema = z.object({
  deleted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'worktree.remove'>>>
