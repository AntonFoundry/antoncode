/** Package-owned durable todo-snapshot invariants. @module @deepseek-ai/dsh-tool-todo/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-todo'
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled'])
const TODO_PRIORITIES = new Set(['high', 'medium', 'low'])

/** Cordis companion plugin name. */
export const name = 'tool-todo-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate one node of a whole-tree todo snapshot before it reaches the durable log.
 *
 * Depth beyond three levels fails loud here even though the tool's JSON schema cannot express
 * it: this invariant also covers snapshots appended by any other writer, so the durable shape
 * promise ("trees nest at most three levels") holds against the log, not just against the tool.
 * The walk is deliberately silent on how many nodes are `in_progress`. That is the tool's
 * per-deployment policy (`Config.allowParallelInProgress`), not a durable-shape rule: a log
 * written while parallel work was allowed must still replay after a deployment tightens the
 * policy, so tying the invariant to the current config would reject history that was valid when
 * it was written.
 */
function validateNode(node: unknown, depth: number, seen: Set<string>, fail: InvariantFailure): void {
  if (typeof node !== 'object' || node === null) fail('todo/write nodes must be objects')
  const record = node as Record<string, unknown>
  if (depth > 3) {
    fail(`todo/write nests deeper than three levels at ${JSON.stringify(record.content)}`)
  }
  const { content, status, priority } = record
  if (typeof content !== 'string' || content.length === 0 || content.trim() !== content) {
    fail('todo/write content must be non-empty and already trimmed')
  }
  if (seen.has(content)) fail(`todo/write repeats content ${JSON.stringify(content)}`)
  seen.add(content)
  if (typeof status !== 'string' || !TODO_STATUSES.has(status)) {
    fail(`todo/write carries unknown status ${JSON.stringify(status)}`)
  }
  if (priority !== undefined && (typeof priority !== 'string' || !TODO_PRIORITIES.has(priority))) {
    fail(`todo/write carries unknown priority ${JSON.stringify(priority)}`)
  }
  const children = record.children
  if (children !== undefined) {
    if (!Array.isArray(children)) fail('todo/write children must be an array when present')
    for (const child of children) validateNode(child, depth + 1, seen, fail)
  }
}

function validateTodos(value: unknown, fail: InvariantFailure): void {
  if (!Array.isArray(value)) fail('todo/write todos must be an array')
  const seen = new Set<string>()
  for (const item of value) validateNode(item, 1, seen, fail)
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'todo/write') validateTodos(event.data.todos, fail)
}

/** Install validation for loaded and newly appended whole-tree todo snapshots. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the todo invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
