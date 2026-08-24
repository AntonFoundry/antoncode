/**
 * Decode an SSE byte stream into event `data` payloads. Framing — chunk
 * reassembly, UTF-8/CRLF/BOM handling, comment and non-data field skipping —
 * is `eventsource-parser`'s. The Codex backend sends no `[DONE]` sentinel:
 * the stream ends right after the terminal event, so EOF is a normal end
 * here (the caller owns the terminal-event contract).
 *
 * @module dsh-llm-codex/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'

/**
 * Parse an SSE byte stream into data payloads, ending cleanly at EOF.
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
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
