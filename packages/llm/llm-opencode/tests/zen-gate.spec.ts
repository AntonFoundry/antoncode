/**
 * Free-tier gate tests: identity headers, marker/history shaping, the text
 * tool protocol, and stream parsing — all pure value mappings, no network.
 */

import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  augmentSystemWithTextProtocol,
  buildTextToolProtocol,
  extractToolBlocks,
  flattenResponsesInput,
  freeTierHeaders,
  freeTierSessionId,
  injectMarker,
  parseFreeTextTools,
  shapeFreeTierBody,
  ZEN_MARKER_PROMPT,
  type FreeTierInputItem,
} from '../src/zen-gate.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const textItem = (text: string): FreeTierInputItem => ({
  role: 'user',
  content: [{ type: 'input_text', text }],
})

/** Raw transcript text of a flattened user item (avoids JSON escaping in assertions). */
function flattenedText(item: FreeTierInputItem): string {
  if ('content' in item && Array.isArray(item.content)) {
    return item.content.map((part: unknown) => (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : '')).join('')
  }
  return JSON.stringify(item)
}

describe('freeTierSessionId', () => {
  it('shapes gate session ids deterministically per clock', () => {
    expect(freeTierSessionId(0, new Uint8Array(14))).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(freeTierSessionId(0, new Uint8Array(14))).toBe(freeTierSessionId(0, new Uint8Array(14)))
  })
})

describe('freeTierHeaders', () => {
  it('stamps the gate client identity', () => {
    expect(freeTierHeaders('ses_x')).toEqual({
      'user-agent': 'opencode/latest/2.0.28/cli',
      'x-opencode-client': 'cli',
      'x-opencode-session': 'ses_x',
    })
  })
})

describe('injectMarker', () => {
  it('prepends the marker once', () => {
    const once = injectMarker([textItem('hi')])
    expect(once[0]).toEqual({ role: 'developer', content: ZEN_MARKER_PROMPT })
    expect(injectMarker(once)).toEqual(once)
  })
})

describe('flattenResponsesInput', () => {
  it('flattens history into marker plus one user message', () => {
    const flattened = flattenResponsesInput([
      { role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      { type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'c1', output: 'x'.repeat(5000) },
      textItem('next?'),
    ])
    expect(flattened).toHaveLength(2)
    expect(flattened[0]).toEqual({ role: 'developer', content: ZEN_MARKER_PROMPT })
    const user = flattened[1]!
    expect(user).toMatchObject({ role: 'user' })
    const text = flattenedText(user)
    expect(text).toContain('[assistant] done')
    expect(text).toContain('[assistant tool call: bash {"a":1}]')
    expect(text).toContain('[tool result for c1:')
    expect(text).toContain('[truncated]')
    expect(text).toContain('[user] next?')
    expect(text).toContain('[reminder]')
  })

  it('parses prior fenced tool calls out of assistant text', () => {
    const flattened = flattenResponsesInput([
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'checking ```tool\n{"name":"read","arguments":{"p":"a"}}\n```' }],
      },
    ])
    const text = flattenedText(flattened[1]!)
    expect(text).toContain('[assistant tool call: read {"p":"a"}]')
    expect(text).toContain('[assistant] checking')
  })
})

describe('shapeFreeTierBody', () => {
  it('removes native tools, prefixes instructions, and keeps reasoning', () => {
    const shaped = shapeFreeTierBody({
      model: 'spark-free',
      input: [textItem('hi')],
      stream: true,
      instructions: 'be nice',
      tools: [{ type: 'function', name: 'bash', description: 'run', parameters: {} }],
      reasoning: { effort: 'high' },
    })
    expect(shaped).toMatchObject({
      model: 'spark-free',
      reasoning: { effort: 'high' },
    })
    expect('tools' in shaped).toBe(false)
    expect(shaped.instructions).toMatch(/^IMPORTANT: Disregard/)
    expect(shaped.instructions).toContain('be nice')
    expect(shaped.input[0]).toEqual({ role: 'developer', content: ZEN_MARKER_PROMPT })
  })

  it('leaves instruction-less bodies without a preamble', () => {
    const shaped = shapeFreeTierBody({ model: 'm', input: [textItem('hi')], stream: true })
    expect(shaped.instructions).toBeUndefined()
  })
})

describe('buildTextToolProtocol', () => {
  it('lists tools with the fenced contract', () => {
    const protocol = buildTextToolProtocol([{ name: 'bash', description: 'run', parameters: { type: 'object' } }])
    expect(protocol).toContain('```tool')
    expect(protocol).toContain('- bash: run')
    expect(protocol).toContain('"type":"object"')
  })
})

describe('extractToolBlocks', () => {
  it('splits prose from one or several calls', () => {
    const parsed = extractToolBlocks(
      'working ```tool\n{"name":"a","arguments":{"x":1}}\n``` mid ```tool\n{"name":"b"}\n``` done',
    )
    expect(parsed.text).toBe('working  mid  done')
    expect(parsed.toolCalls.map(call => [call.id, call.name])).toEqual([
      ['call_zen_1', 'a'],
      ['call_zen_2', 'b'],
    ])
    expect(parsed.toolCalls[0]!.arguments).toEqual({ x: 1 })
    expect(parsed.toolCalls[1]!.arguments).toEqual({})
  })

  it('leaves malformed and nameless fences visible', () => {
    const parsed = extractToolBlocks('oops ```tool\nnope\n``` and ```tool\n{"arguments":{}}\n``` end')
    expect(parsed.toolCalls).toEqual([])
    expect(parsed.text).toContain('```tool')
  })
})

describe('augmentSystemWithTextProtocol', () => {
  const tools = [{ name: 'bash', description: 'run', parameters: { type: 'object' } }]
  const base = { provider: 'opencode-free', model: 'm', messages: [] as never[] }

  it('appends the protocol for tool turns and passes the rest through', () => {
    const shaped = augmentSystemWithTextProtocol({ ...base, system: 'sys', tools })
    expect(shaped.system).toContain('sys')
    expect(shaped.system).toContain('```tool')
    expect(augmentSystemWithTextProtocol({ ...base, tools: [] }).system).toBeUndefined()
    expect(augmentSystemWithTextProtocol({
      ...base,
      tools,
      reasoningEffort: ReasoningEffortId('high'),
      purpose: 'session-title' as const,
    }).system).toBeUndefined()
  })
})

describe('parseFreeTextTools', () => {
  async function collect(chunks: StreamChunk[]): Promise<StreamChunk[]> {
    const out: StreamChunk[] = []
    for await (const chunk of parseFreeTextTools(chunks)) out.push(chunk)
    return out
  }

  const textEnd = (index: number, text: string): StreamChunk => ({
    type: 'block-end',
    index,
    block: { type: 'text', text },
  })

  it('passes fence-free turns through with cleaned ends', async () => {
    const chunks = await collect([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello' },
      textEnd(0, 'hello'),
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello' },
      textEnd(0, 'hello'),
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('splits fenced calls into triples on fresh indices', async () => {
    const chunks = await collect([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'run ' },
      { type: 'text-delta', index: 0, text: '```tool\n{"name":"bash","arguments":{"c":"ls"}}\n```' },
      textEnd(0, 'run ```tool\n{"name":"bash","arguments":{"c":"ls"}}\n```'),
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'run ' },
      { type: 'text-delta', index: 0, text: '```tool\n{"name":"bash","arguments":{"c":"ls"}}\n```' },
      textEnd(0, 'run'),
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      {
        type: 'tool-call-delta',
        index: 1,
        id: 'call_zen_1',
        name: 'bash',
        argumentsDelta: '{"c":"ls"}',
      },
      {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: 'call_zen_1', name: 'bash', arguments: '{"c":"ls"}' },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('passes non-text and reasoning chunks through untouched', async () => {
    const usage = {
      type: 'usage',
      usage: { inputTokens: 1, outputTokens: 2 },
    } as StreamChunk
    const chunks = await collect([
      { type: 'block-start', index: 3, blockType: 'reasoning' },
      usage,
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 3, blockType: 'reasoning' },
      usage,
    ])
  })
})
