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
 * - Tool calls a model streamed without an id or name, which the fork logged
 *   with `""` (and answered with an unknown-tool error), are repaired by
 *   {@link AntonEmptyToolCallRepair}. Upstream requires non-empty ids and names
 *   on the Assistant message, `tool/call`, and `tool/result`.
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

/** The tool name given to a fork tool call the model emitted without a name. */
export const ANTON_EMPTY_TOOL_CALL_NAME = 'invalid_tool_call'

/**
 * Repairs the fork's empty tool-call ids and names in one Session's v0 events,
 * applied in log order.
 *
 * - A `tool-call` block with id `""`, on an Assistant message or a
 *   `block-end` chunk, receives `anton-empty-call-<turn>-<step>-<block index>`,
 *   so the streamed block and the final message name the same call.
 * - Each later `tool/call` with callId `""` takes the oldest unclaimed repaired
 *   id, and each `tool/result` with callId `""` takes the oldest id claimed by a
 *   `tool/call` and not yet answered. Every such call failed with the same
 *   unknown-tool error, so pairing in log order loses nothing.
 * - A `""` tool name on a block or `tool/call` becomes
 *   {@link ANTON_EMPTY_TOOL_CALL_NAME}.
 * - A `tool-call-delta` chunk's `name: null` is omitted; empty-id deltas stay as
 *   written, which the upstream Assistant stream accepts.
 *
 * An empty id with no repaired id to take stays `""`, so payload validation
 * still rejects the Session.
 */
export class AntonEmptyToolCallRepair {
  private readonly unclaimed: string[] = []
  private readonly unanswered: string[] = []

  /**
   * Repair one v0 event.
   * @param event - one source v0 event, after {@link normalizeAntonForkV0Event}.
   * @returns the event unchanged when it carries no empty tool-call id or name, otherwise the repaired event.
   */
  normalize(event: SessionFormatEvent): SessionFormatEvent {
    const data = event.data
    if (!isRecord(data)) return event
    switch (event.type) {
      case 'assistant/message':
        return this.#message(event, data)
      case 'tool/call': {
        if (data['callId'] !== '' && data['name'] !== '') return event
        const repaired = { ...data }
        const callId = data['callId'] === '' ? this.unclaimed.shift() : undefined
        if (callId !== undefined) {
          repaired['callId'] = callId
          this.unanswered.push(callId)
        }
        if (data['name'] === '') repaired['name'] = ANTON_EMPTY_TOOL_CALL_NAME
        return { ...event, data: repaired }
      }
      case 'tool/result':
        return this.#result(event, data)
      case 'assistant/chunk': {
        const chunk = data['chunk']
        if (!isRecord(chunk)) return event
        if (chunk['type'] === 'tool-call-delta' && chunk['name'] === null) {
          const { name: _null, ...rest } = chunk
          return { ...event, data: { ...data, chunk: rest } }
        }
        if (chunk['type'] !== 'block-end' || typeof chunk['index'] !== 'number') return event
        const block = repairBlock(chunk['block'], data, chunk['index'], () => {})
        return block === undefined ? event : { ...event, data: { ...data, chunk: { ...chunk, block } } }
      }
      default:
        return event
    }
  }

  #message(event: SessionFormatEvent, data: { [key: string]: SessionFormatJsonValue }): SessionFormatEvent {
    const message = data['message']
    if (!isRecord(message) || !Array.isArray(message['content'])) return event
    const blocks: readonly SessionFormatJsonValue[] = message['content']
    const content = blocks.map((block, index) => repairBlock(block, data, index, id => this.unclaimed.push(id)) ?? block)
    return content.some((block, index) => block !== blocks[index])
      ? { ...event, data: { ...data, message: { ...message, content } } }
      : event
  }

  #result(event: SessionFormatEvent, data: { [key: string]: SessionFormatJsonValue }): SessionFormatEvent {
    const message = data['message']
    if (!isRecord(message) || !isRecord(message['source']) || message['source']['callId'] !== '') return event
    const content: SessionFormatJsonValue | undefined = message['content']
    const block = Array.isArray(content) && content.length === 1 ? content[0] as SessionFormatJsonValue : undefined
    if (!isRecord(block) || block['toolCallId'] !== '') return event
    const callId = this.unanswered.shift()
    if (callId === undefined) return event
    return {
      ...event,
      data: {
        ...data,
        message: { ...message, source: { ...message['source'], callId }, content: [{ ...block, toolCallId: callId }] },
      },
    }
  }
}

/**
 * Repair one content block's empty tool-call id and name.
 * @param block - one content block.
 * @param data - the carrying event's data, which names its turn and step.
 * @param index - the block's content index.
 * @param onRepairedId - receives the id given to a block whose id was empty.
 * @returns the repaired block, or `undefined` when the block needs no repair.
 */
function repairBlock(
  block: SessionFormatJsonValue | undefined,
  data: { [key: string]: SessionFormatJsonValue },
  index: number,
  onRepairedId: (id: string) => void,
): { [key: string]: SessionFormatJsonValue } | undefined {
  if (!isRecord(block) || block['type'] !== 'tool-call' || (block['id'] !== '' && block['name'] !== '')) return undefined
  const repaired = { ...block }
  if (block['id'] === '') {
    const id = `anton-empty-call-${JSON.stringify(data['turn'])}-${JSON.stringify(data['step'])}-${index}`
    repaired['id'] = id
    onRepairedId(id)
  }
  if (block['name'] === '') repaired['name'] = ANTON_EMPTY_TOOL_CALL_NAME
  return repaired
}
