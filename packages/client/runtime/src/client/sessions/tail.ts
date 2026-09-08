/**
 * Board-pane activity tail: derive a handful of display lines from a
 * session's history tail page. Pure over the wire entries — the object layer
 * owns the derivation so carriers and presentation never see raw events.
 * Self-contained value types: the contract imports them from here, keeping
 * the type-graph surface of this module local.
 * @module @deepseek-ai/dsh-client-runtime/client/sessions/tail
 */

/** One derived activity line in a session's board tail. */
export interface SessionTailLine {
  kind: 'user' | 'tool' | 'assistant' | 'error'
  label: string
}

/**
 * Compact activity tail for a session pane, derived from the history tail
 * page — display lines, never raw events.
 */
export interface SessionTail {
  lines: readonly SessionTailLine[]
  /** Seq of the last event the tail reflects (the poll's change cursor). */
  lastSeq: number
}

/** Maximum display lines in one tail; the newest win. */
const TAIL_LINES = 4
/** Character cap for one line's label; longer text truncates with an ellipsis. */
const LABEL_CAP = 120

/** The narrow event view the derivation reads: type discriminator + seq + payload. */
export interface TailEvent {
  type: string
  seq: number
  data: {
    content?: readonly { type: string; text?: string }[]
    message?: { content?: readonly { type: string; text?: string; isError?: boolean }[] }
    name?: string
    arguments?: string
  }
}

/** Text out of a message's content blocks: the text blocks joined, truncated. */
function textSnippet(blocks: readonly { type: string; text?: string }[] | undefined): string {
  const text = (blocks ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join(' ')
    .trim()
  return text.length > LABEL_CAP ? `${text.slice(0, LABEL_CAP - 1)}…` : text
}

/** First interesting string argument of a tool call, truncated. */
function toolDetail(argsJson: string | undefined): string {
  if (argsJson === undefined) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return ''
  }
  if (typeof parsed !== 'object' || parsed === null) return ''
  const record = parsed as Record<string, unknown>
  const preferred = record.path ?? record.file_path ?? record.command ?? record.pattern ?? record.query
    ?? Object.values(record).find(value => typeof value === 'string')
  if (typeof preferred !== 'string' || preferred.length === 0) return ''
  const detail = preferred.length > 60 ? `${preferred.slice(0, 59)}…` : preferred
  return ` ${detail}`
}

/**
 * Derive the tail lines: walk the newest events backward, keeping user
 * prompts, tool runs, assistant text, and failures; boundary markers and
 * stream chunks fall through. Newest-first collection reversed at the end so
 * the pane reads top-down.
 * @param entries - the history page's raw events (any order; newest last).
 * @returns the tail lines and the highest event seq seen.
 */
export function deriveSessionTail(entries: readonly TailEvent[]): SessionTail {
  const lines: SessionTailLine[] = []
  let lastSeq = -1
  for (let i = entries.length - 1; i >= 0 && lines.length < TAIL_LINES; i--) {
    const event = entries[i]
    if (event === undefined) continue
    lastSeq = Math.max(lastSeq, event.seq)
    switch (event.type) {
      case 'user/message': {
        const label = textSnippet(event.data.content)
        if (label.length > 0) lines.push({ kind: 'user', label: `» ${label}` })
        break
      }
      case 'tool/call':
        lines.push({ kind: 'tool', label: `Ran ${event.data.name}${toolDetail(event.data.arguments)}` })
        break
      case 'tool/result': {
        if (event.data.message?.content?.[0]?.isError === true) {
          lines.push({ kind: 'error', label: 'Tool failed — see the session for details' })
        }
        break
      }
      case 'assistant/message': {
        const label = textSnippet(event.data.message?.content)
        if (label.length > 0) lines.push({ kind: 'assistant', label })
        break
      }
      default:
        // Boundary markers, chunks, and merge-extension event types carry no
        // tail line.
        break
    }
  }
  return { lines: lines.reverse(), lastSeq }
}
