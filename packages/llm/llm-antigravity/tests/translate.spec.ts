// Unit tests for the Antigravity translate layer: schema cleaning, tool-name
// sanitization, and — most critically — the cumulative SSE snapshot-dedupe
// buffer that turns Antigravity's re-sent parts[] snapshots into deltas.

import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import {
  cleanSchema,
  initialSnapshotState,
  mapFinishReason,
  retryAfterSeconds,
  retryDelayMs,
  safeParseArgs,
  sanitizeToolName,
  translateSnapshot,
  translateUsage,
  wireModelOf,
  translateMessage,
} from '../src/translate.ts'
import type { GeminiPart } from '../src/translate.ts'

describe('cleanSchema', () => {
  it('keeps the allowlist and drops unsupported keywords', () => {
    const cleaned = cleanSchema({
      type: 'OBJECT',
      description: 'args',
      properties: { path: { type: 'string', description: 'file', $ref: '#/$defs/x', default: '/tmp' } },
      required: ['path'],
      $defs: { x: { type: 'string' } },
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
    })
    expect(cleaned).toBeDefined()
    expect(cleaned!.type).toBe('object')
    expect(cleaned!.required).toEqual(['path'])
    expect(cleaned!.$defs).toBeUndefined()
    expect(cleaned!.$schema).toBeUndefined()
    const props = cleaned!.properties as Record<string, Record<string, unknown>>
    expect(props.path!.$ref).toBeUndefined()
    expect(props.path!.default).toBeUndefined()
    expect(props.path!.description).toBe('file')
  })

  it('converts const to a single-value enum', () => {
    const cleaned = cleanSchema({ type: 'object', const: 'fixed' })
    expect(cleaned!.enum).toEqual(['fixed'])
  })

  it('gives an empty object schema a placeholder property', () => {
    const cleaned = cleanSchema({ type: 'object' })
    const props = cleaned!.properties as Record<string, unknown>
    expect(Object.keys(props).length).toBeGreaterThan(0)
  })

  it('returns undefined for non-object schemas', () => {
    expect(cleanSchema('string')).toBeUndefined()
    expect(cleanSchema([1])).toBeUndefined()
  })
})

describe('sanitizeToolName', () => {
  it('replaces invalid characters with underscores', () => {
    expect(sanitizeToolName('mcp/query')).toBe('mcp_query')
    expect(sanitizeToolName('read file')).toBe('read_file')
  })
  it('prefixes names that do not start with a letter or underscore', () => {
    expect(sanitizeToolName('1mcp')).toBe('_1mcp')
    expect(sanitizeToolName('-dash')).toBe('_-dash')
  })
  it('keeps dots and colons and truncates to 64 chars', () => {
    expect(sanitizeToolName('mcp:mongodb.query')).toBe('mcp:mongodb.query')
    expect(sanitizeToolName('a'.repeat(80)).length).toBe(64)
  })
})

describe('translateSnapshot cumulative dedupe', () => {
  it('emits only the growth between cumulative snapshots', () => {
    const state = initialSnapshotState()
    const first = translateSnapshot([{ text: 'Hello' }], state, 0)
    expect(first).toEqual([{ type: 'text-delta', index: 0, text: 'Hello' }])
    // Second snapshot re-sends 'Hello world' cumulatively: only ' world' emits.
    const second = translateSnapshot([{ text: 'Hello world' }], state, 0)
    expect(second).toEqual([{ type: 'text-delta', index: 0, text: ' world' }])
    // An identical snapshot emits nothing.
    const third = translateSnapshot([{ text: 'Hello world' }], state, 0)
    expect(third).toEqual([])
  })

  it('emits thinking parts as reasoning deltas', () => {
    const state = initialSnapshotState()
    const parts: GeminiPart[] = [{ thought: true, text: 'thinking...' }]
    const chunks = translateSnapshot(parts, state, 0)
    expect(chunks).toEqual([{ type: 'reasoning-delta', index: 0, text: 'thinking...' }])
  })

  it('emits a function call as one complete tool-call block', () => {
    const state = initialSnapshotState()
    const parts: GeminiPart[] = [
      { functionCall: { name: 'read', args: { file_path: '/a' }, id: 'toolu_1' } },
    ]
    const chunks = translateSnapshot(parts, state, 0)
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'tool-call-delta', 'block-end'])
    const delta = chunks[1] as { type: 'tool-call-delta'; id: string; name: string; argumentsDelta: string }
    expect(delta.id).toBe('toolu_1')
    expect(delta.name).toBe('read')
    expect(JSON.parse(delta.argumentsDelta)).toEqual({ file_path: '/a' })
    // The same call re-sent cumulatively emits nothing further.
    expect(translateSnapshot(parts, state, 0)).toEqual([])
  })

  it('synthesizes a call id when the gateway omits one', () => {
    const state = initialSnapshotState()
    const chunks = translateSnapshot([{ functionCall: { name: 'bash', args: {} } }], state, 0)
    const delta = chunks[1] as { id: string }
    expect(delta.id).toMatch(/^antigravity-call-/)
  })

  it('returns nothing for an undefined parts array', () => {
    expect(translateSnapshot(undefined, initialSnapshotState(), 0)).toEqual([])
  })
})

describe('translateUsage', () => {
  it('subtracts cached tokens from the prompt count', () => {
    const chunk = translateUsage({
      response: { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 40, thoughtsTokenCount: 5 } },
    })
    expect(chunk).toBeDefined()
    if (chunk !== undefined && chunk.type === 'usage') {
      expect(chunk.usage.inputTokens).toBe(60)
      expect(chunk.usage.cacheReadTokens).toBe(40)
      expect(chunk.usage.outputTokens).toBe(20)
      expect(chunk.usage.reasoningTokens).toBe(5)
    }
  })
  it('returns undefined when the event carries no usageMetadata', () => {
    expect(translateUsage({ response: {} })).toBeUndefined()
  })
})

describe('mapFinishReason', () => {
  it('maps STOP to stop (and tool-calls when a tool call streamed)', () => {
    expect(mapFinishReason('STOP', false)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    const toolFinish = mapFinishReason('STOP', true)
    if (toolFinish.type === 'finish') {
      expect(toolFinish.reason).toEqual({ kind: 'tool-calls' })
    }
  })
  it('maps MAX_TOKENS to max-tokens', () => {
    const maxFinish = mapFinishReason('MAX_TOKENS', false)
    if (maxFinish.type === 'finish') {
      expect(maxFinish.reason).toEqual({ kind: 'max-tokens' })
    }
  })
  it('maps safety and other reasons to an error finish', () => {
    const finish = mapFinishReason('SAFETY', false)
    expect(finish.type).toBe('finish')
    if (finish.type === 'finish') {
      expect(finish.reason).toMatchObject({ kind: 'error' })
    }
  })
})

describe('retry helpers', () => {
  it('parses a seconds Retry-After header', () => {
    expect(retryAfterSeconds('3')).toBe(3000)
    expect(retryAfterSeconds(null)).toBeUndefined()
    expect(retryAfterSeconds('soon')).toBeUndefined()
  })
  it('parses a Google RetryInfo retryDelay from error details', () => {
    const details = [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3.95s' }]
    expect(retryDelayMs(details)).toBe(3950)
    expect(retryDelayMs(undefined)).toBeUndefined()
  })
})

describe('safeParseArgs', () => {
  it('parses valid JSON object arguments', () => {
    expect(safeParseArgs('{"a":1}')).toEqual({ a: 1 })
  })
  it('tolerates malformed JSON and empty input', () => {
    expect(safeParseArgs('')).toEqual({})
    expect(safeParseArgs('{broken')).toEqual({ _raw: '{broken' })
    expect(safeParseArgs('[1,2]')).toEqual({})
  })
})

describe('wireModelOf (harness id → Antigravity wire id)', () => {
  it('appends the required tier suffix to Gemini 3.x Pro models', () => {
    expect(wireModelOf('gemini-3.1-pro')).toBe('gemini-3.1-pro-low')
    expect(wireModelOf('gemini-3.1-pro', 'high')).toBe('gemini-3.1-pro-high')
    expect(wireModelOf('gemini-3-pro', 'medium')).toBe('gemini-3-pro-low')
  })
  it('keeps an explicit tier suffix and strips the opencode quota prefix', () => {
    expect(wireModelOf('gemini-3.1-pro-high')).toBe('gemini-3.1-pro-high')
    expect(wireModelOf('antigravity-gemini-3.1-pro')).toBe('gemini-3.1-pro-low')
  })
  it('leaves Flash and Claude models bare', () => {
    expect(wireModelOf('gemini-3-flash')).toBe('gemini-3-flash')
    expect(wireModelOf('claude-sonnet-4-6', 'high')).toBe('claude-sonnet-4-6')
  })
})

describe('replayed tool-call thought signatures', () => {
  const call = (id: string) => ({ type: 'tool-call' as const, id: CallId(id), name: 'bash', arguments: '{"command":"ls"}' })

  it('marks the first functionCall of a block with the sentinel', () => {
    const message = {
      id: 'm1' as never, role: 'assistant' as const,
      content: [call('c1'), call('c2')],
      source: { kind: 'model' as const, provider: 'antigravity', model: 'gemini-3.1-pro' },
    }
    const translated = translateMessage(message)
    const first = translated!.parts[0] as { functionCall: unknown; thoughtSignature?: string }
    const second = translated!.parts[1] as { functionCall: unknown; thoughtSignature?: string }
    expect(first.thoughtSignature).toBe('skip_thought_signature_validator')
    expect(second.thoughtSignature).toBeUndefined()
  })
})
