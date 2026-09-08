/**
 * Board tail derivation spec: the pure walk over a history tail page — tool
 * runs, user prompts, assistant text, and failures become display lines;
 * boundary markers and chunks never do. Newest events win when the page
 * outnumbers the line cap.
 */
import { describe, expect, it } from 'vitest'
import { deriveSessionTail } from '../src/client/sessions/tail.ts'

let seq = 0
type Entries = Parameters<typeof deriveSessionTail>[0]
function event(type: string, data: Record<string, unknown>): Entries[number] {
  seq += 1
  // The derivation reads only type/seq/data; the synthetic entries narrow to
  // the wire shape it consumes.
  return { type, seq, time: 0, data } as unknown as Entries[number]
}

describe('deriveSessionTail', () => {
  it('derives tool, user, and assistant lines newest-last', () => {
    const tail = deriveSessionTail([
      event('turn/start', { turn: 1 }),
      event('user/message', { content: [{ type: 'text', text: 'fix the lint' }] }),
      event('tool/call', { name: 'bash', arguments: JSON.stringify({ command: 'pnpm run lint' }) }),
      event('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] } }),
      event('assistant/message', { message: { content: [{ type: 'text', text: 'All green.' }] } }),
    ])
    expect(tail.lines.map(line => `${line.kind}:${line.label}`)).toEqual([
      'user:» fix the lint',
      'tool:Ran bash pnpm run lint',
      'assistant:All green.',
    ])
    expect(tail.lastSeq).toBe(seq)
  })

  it('marks failed tool results as error lines after the run', () => {
    const tail = deriveSessionTail([
      event('tool/call', { name: 'bash', arguments: '{}' }),
      event('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: true }] } }),
    ])
    expect(tail.lines.map(line => line.kind)).toEqual(['tool', 'error'])
  })

  it('keeps only the newest lines when the page outnumbers the cap', () => {
    const entries = []
    for (let i = 0; i < 8; i++) entries.push(event('tool/call', { name: `tool${i}`, arguments: '{}' }))
    const tail = deriveSessionTail(entries)
    expect(tail.lines).toHaveLength(4)
    expect(tail.lines[0]?.label).toBe('Ran tool4')
    expect(tail.lines[3]?.label).toBe('Ran tool7')
  })

  it('ignores chunks and boundary events entirely', () => {
    const tail = deriveSessionTail([
      event('assistant/chunk', { chunk: {} }),
      event('step/start', { turn: 1, step: 1 }),
    ])
    expect(tail.lines).toEqual([])
    expect(tail.lastSeq).toBe(seq)
  })

  it('survives unparseable tool arguments', () => {
    const tail = deriveSessionTail([event('tool/call', { name: 'bash', arguments: 'not json' })])
    expect(tail.lines).toEqual([{ kind: 'tool', label: 'Ran bash' }])
  })
})
