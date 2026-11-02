/**
 * Normalization of the format-v0 records Anton's 0.1.x fork wrote that the
 * upstream released-v0 inventory does not accept, applied before every other
 * v0→v1 normalization. Each rule maps a fork construct to the upstream v0 form
 * it corresponds to; nothing upstream wrote is changed.
 *
 * - Fork-only event types (`c0ntext/window`, `c0ntext/mirror-ack`,
 *   `c0ntext/page-enrichment`, `c0ntext/page-archive`, `plan/write`) pass
 *   through unchanged except for `ignorable: true`: the payload belongs to its
 *   producer and is not inspected, later edges and readers keep unknown
 *   ignorable events opaque, and a mounted producer that still declares the
 *   type reads it. Payload members that name sequence numbers are not
 *   renumbered by later edges.
 * - `subagent/descriptor` version 2 is the fork's name for the released v3
 *   continuable and one-shot descriptors (same members and meaning), so it is
 *   renumbered.
 * - `todo/write` todos become upstream's flat `{ content, status }` list: the
 *   fork's Todo Tree `children` are flattened depth-first after their parent,
 *   each nested `content` indented with `↳` per level, and fork-only members
 *   such as `priority` are dropped. The fork's `cancelled` status, which
 *   upstream lacks, becomes `completed` with ` [cancelled]` appended to the
 *   content so the outcome stays visible.
 */
import type { SessionFormatEvent, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

/** Event types only Anton's fork wrote; carried through as ignorable. */
export const ANTON_FORK_V0_EVENT_TYPES: ReadonlySet<string> = new Set([
  'c0ntext/window',
  'c0ntext/mirror-ack',
  'c0ntext/page-enrichment',
  'c0ntext/page-archive',
  'plan/write',
])

function isRecord(value: SessionFormatJsonValue | undefined): value is { [key: string]: SessionFormatJsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Map one fork-written v0 event to the upstream v0 form it corresponds to.
 * @param event - one source v0 event.
 * @returns the event unchanged when no rule applies, otherwise the normalized event.
 */
export function normalizeAntonForkV0Event(event: SessionFormatEvent): SessionFormatEvent {
  if (ANTON_FORK_V0_EVENT_TYPES.has(event.type)) return { ...event, ignorable: true }
  const data = event.data
  if (!isRecord(data)) return event
  if (event.type === 'subagent/descriptor' && data['version'] === 2
    && (data['mode'] === 'continuable' || data['mode'] === 'one-shot')) {
    return { ...event, data: { ...data, version: 3 } }
  }
  if (event.type === 'todo/write' && Array.isArray(data['todos'])) {
    const todos: readonly SessionFormatJsonValue[] = data['todos']
    if (todos.every(isUpstreamTodo)) return event
    return { ...event, data: { ...data, todos: todos.flatMap(todo => flattenTodo(todo, 0)) } }
  }
  return event
}

/** An upstream v0 todo: exactly `content` and `status`. */
function isUpstreamTodo(todo: SessionFormatJsonValue): boolean {
  return isRecord(todo) && todo['status'] !== 'cancelled'
    && Object.keys(todo).every(key => key === 'content' || key === 'status')
}

/**
 * Flatten one fork todo and its `children` into upstream todos, parent first.
 * @param todo - one fork todo record.
 * @param depth - nesting level, 0 for a top-level todo.
 * @returns the upstream todos in depth-first order.
 */
function flattenTodo(todo: SessionFormatJsonValue, depth: number): SessionFormatJsonValue[] {
  if (!isRecord(todo)) return [todo]
  const content = typeof todo['content'] === 'string' ? todo['content'] : ''
  const cancelled = todo['status'] === 'cancelled'
  const text = cancelled ? `${content} [cancelled]` : content
  const own = {
    content: depth === 0 ? text : `${'  '.repeat(depth - 1)}↳ ${text}`,
    status: cancelled ? 'completed' : todo['status'] ?? 'pending',
  }
  const children: readonly SessionFormatJsonValue[] = Array.isArray(todo['children']) ? todo['children'] : []
  return [own, ...children.flatMap(child => flattenTodo(child, depth + 1))]
}
