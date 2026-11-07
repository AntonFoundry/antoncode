/** Recorded queue settlements reconstruct Mail rows without repeating queue delivery. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  agentMailQueueSendDefinition,
  agentMailReceiveDefinition,
  agentMailRelayView,
  agentMailSendDefinition,
} from '../src/client/relay-projection.ts'

const cases = [
  { mode: 'native', file: 'session.v4.jsonl', body: 'Native queue correspondence' },
  { mode: 'ptc', file: 'session.1.v4.jsonl', body: 'PTC queue correspondence' },
] as const

const receiptSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().positive(),
  workspaceId: z.string().min(1),
  sender: z.string().min(1),
  recipients: z.array(z.string().min(1)).min(1),
  workspaceWide: z.literal(true),
  body: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
})

function receipt(content: readonly ContentBlock[]) {
  const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const value: unknown = JSON.parse(text)
  return receiptSchema.parse(value)
}

/** Validate materialized current fixture rows through the owning Session seed admission. */
function parseSessionLog(text: string): readonly SessionEvent[] {
  const rows = text.split(/\r?\n/).filter(line => line.trim() !== '').map((line) => {
    const value: unknown = JSON.parse(line)
    return z.record(z.string(), z.unknown()).parse(value)
  })
  const header = rows.shift()
  if (header?.['type'] !== 'session' || header['version'] !== 4) throw new Error('recorded correspondence requires a current V4 Session')
  const seed = rows.map((row, index) => ({ ...row, seq: SessionSeq(index), time: index }) as SessionEvent)
  const validated = Session.create(SessionId('recorded-mail-projection'), seed)
  // Seed validation appends a lifecycle marker outside the recorded event range.
  return validated.snapshotEvents(SessionLogOffset(0), SessionLogOffset(seed.length))
}

function assembler(): ConversationNodeAssembler {
  const assembly = new ConversationNodeAssembler({
    entries: () => [agentMailSendDefinition, agentMailReceiveDefinition, agentMailQueueSendDefinition],
    fallbackEntry: () => undefined,
  }, { entries: () => [agentMailRelayView] })
  assembly.activateTarget('agent-mail')
  return assembly
}

function replace(assembly: ConversationNodeAssembler, events: readonly SessionEvent[]) {
  assembly.replaceWindow(events.map(event => ({ type: 'event' as const, event })), false)
  assembly.flush()
  return assembly.get('agent-mail')
}

describe('recorded Agent Mail queue correspondence projection', () => {
  it.each(cases)('reconstructs $mode broadcast correspondence from its accepted durable result', async ({ mode, file, body }) => {
    const fixture = fileURLToPath(new URL(`../../../../snapshots/web/agent-mail-correspondence/${file}`, import.meta.url))
    const events = parseSessionLog(await readFile(fixture, 'utf8'))
    const nativeCall = events.flatMap(event => event.type === 'tool/call' && event.data.name === 'agent_queue_send' ? [event] : [])[0]
    const nativeResult = nativeCall === undefined ? undefined : events.flatMap(event => event.type === 'tool/result'
      && event.data.message.source.callId === nativeCall.data.callId ? [event] : [])[0]
    const nested = events.flatMap(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'agent_queue_send' ? [event] : [])[0]
    const settlement = mode === 'native' ? nativeResult : nested
    if (settlement === undefined) throw new Error(`${file} has no recorded ${mode} queue settlement`)
    const accepted = settlement.type === 'tool/result'
      ? receipt(settlement.data.message.content) : receipt(settlement.data.content)
    expect(settlement.type === 'tool/result' ? settlement.data.message.isError : settlement.data.isError).not.toBe(true)
    expect(accepted.body).toBe(body)
    expect(new Set(accepted.recipients).size).toBe(accepted.recipients.length)
    const expected = [{
      key: `queue:local:${accepted.id}`,
      direction: 'outgoing',
      channel: 'local',
      peer: accepted.recipients[0],
      recipients: accepted.recipients,
      workspaceId: accepted.workspaceId,
      seq: accepted.seq,
      body: accepted.body,
      at: accepted.createdAt,
    }]
    const assembly = assembler()
    const rows = replace(assembly, events)
    expect(rows).toEqual(expected)
    expect(replace(assembly, events)).toBe(rows)

    const closedTurn = events.findLast(event => event.type === 'turn/end')
    expect(closedTurn?.data.reason.kind).toBe('completed')
    const trailing = events.at(-1)
    if (trailing === undefined || (trailing.type !== 'turn/end' && trailing.type !== 'session/title')) {
      throw new Error(`${file} must end in a settled turn or its title`)
    }
    const beforeTrailing = replace(assembly, events.slice(0, -1))
    assembly.append({ type: 'event', event: trailing })
    assembly.flush()
    expect(assembly.get('agent-mail')).toBe(beforeTrailing)

    if (mode === 'native') {
      if (nativeCall === undefined || nativeResult === undefined) throw new Error(`${file} has no recorded native call/result pair`)
      const paged = assembler()
      expect(replace(paged, [nativeResult])).toEqual([])
      paged.prepend([{ type: 'event', event: nativeCall }], false)
      paged.flush()
      expect(paged.get('agent-mail')).toEqual(expected)
      const pending = assembler()
      expect(replace(pending, [nativeCall])).toEqual([])
      pending.append({ type: 'event', event: nativeResult })
      pending.flush()
      expect(pending.get('agent-mail')).toEqual(expected)
    } else {
      if (nested === undefined) throw new Error(`${file} has no recorded nested queue settlement`)
      const standalone = assembler()
      expect(replace(standalone, [nested])).toEqual(expected)
      const outer = events.flatMap(event => event.type === 'tool/result'
        && event.data.message.source.callId === nested.data.rootCallId ? [event] : [])[0]
      if (outer === undefined) throw new Error(`${file} has no recorded outer PTC result`)
      const beforeOuter = standalone.get('agent-mail')
      standalone.append({ type: 'event', event: outer })
      standalone.flush()
      expect(standalone.get('agent-mail')).toBe(beforeOuter)
    }
  })
})
