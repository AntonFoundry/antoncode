/**
 * Decode an SSE byte stream into event `data` payloads, delegating framing to
 * `eventsource-parser`. Antigravity sends no `[DONE]` sentinel — each `data:`
 * line is a cumulative response snapshot and the stream ends at EOF.
 *
 * @module @deepseek-ai/dsh-llm-antigravity/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'

/**
 * Parse an SSE byte stream into data payloads, ending cleanly at EOF.
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8.
 * @param onComment - optional transport-activity callback.
 * @returns each event's data payload in arrival order.
 */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const { data } of events) {
    if (data.length === 0) continue
    yield data
  }
}
