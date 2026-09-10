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

/** Tail density: `brief` is the board's four-line summary; `cli` renders a
 *  taller, rawer transcript — every tool run with its argument, tool output
 *  text, and wider assistant lines — the pane's terminal-style projection. */
export type TailDepth = 'brief' | 'cli'

/** Lines and caps for one depth. */
function depthSpec(depth: TailDepth): { maxLines: number; labelCap: number } {
  return depth === 'cli' ? { maxLines: 24, labelCap: 240 } : { maxLines: TAIL_LINES, labelCap: LABEL_CAP }
}

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
function textSnippet(blocks: readonly { type: string; text?: string }[] | undefined, cap: number): string {
  const text = (blocks ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join(' ')
    .trim()
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text
}

/** First interesting string argument of a tool call, truncated. */
function toolDetail(argsJson: string | undefined, cap: number): string {
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
  const detail = preferred.length > cap ? `${preferred.slice(0, cap - 1)}…` : preferred
  return ` ${detail}`
}

/**
 * Derive the tail lines: walk the newest events backward, keeping user
 * prompts, tool runs (with their output text in `cli` depth), assistant text,
 * and failures; boundary markers and stream chunks fall through.
 * Newest-first collection reversed at the end so the pane reads top-down.
 * @param entries - the history page's raw events (any order; newest last).
 * @param depth - tail density; `cli` renders the taller raw-style transcript.
 * @returns the tail lines and the highest event seq seen.
 */
export function deriveSessionTail(entries: readonly TailEvent[], depth: TailDepth = 'brief'): SessionTail {
  const { maxLines, labelCap } = depthSpec(depth)
  const lines: SessionTailLine[] = []
  let lastSeq = -1
  for (let i = entries.length - 1; i >= 0 && lines.length < maxLines; i--) {
    const event = entries[i]
    if (event === undefined) continue
    lastSeq = Math.max(lastSeq, event.seq)
    switch (event.type) {
      case 'user/message': {
        const label = textSnippet(event.data.content, labelCap)
        if (label.length > 0) lines.push({ kind: 'user', label: `» ${label}` })
        break
      }
      case 'tool/call': {
        const prefix = depth === 'cli' ? '$ ' : 'Ran '
        lines.push({ kind: 'tool', label: `${prefix}${event.data.name ?? ''}${toolDetail(event.data.arguments, depth === 'cli' ? 180 : 60)}` })
        break
      }
      case 'tool/result': {
        const failed = event.data.message?.content?.[0]?.isError === true
        if (failed) {
          lines.push({ kind: 'error', label: 'Tool failed — see the session for details' })
        } else if (depth === 'cli') {
          // The tool's output text: the terminal projection's whole point.
          const out = textSnippet(event.data.message?.content, labelCap)
          if (out.length > 0) lines.push({ kind: 'tool', label: `  ${out.replaceAll('\n', ' ⏎ ')}` })
        }
        break
      }
      case 'assistant/message': {
        const label = textSnippet(event.data.message?.content, labelCap)
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
