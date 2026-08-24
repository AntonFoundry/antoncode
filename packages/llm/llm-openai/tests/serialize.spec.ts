import { describe, expect, it } from 'vitest'
import { CallId, ReasoningEffortId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { reasoningEffortWire, serializeMessages, serializeRequest } from '../src/serialize.ts'

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'openai', model: 'gpt-4o', messages: [], ...overrides }
}

describe('serializeMessages', () => {
  it('maps user text to string content', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'user', content: 'hello world' }])
  })

  it('maps system-role messages in history', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'system', content: [{ type: 'text', text: 'be brief' }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'system', content: 'be brief' }])
  })

  it('drops reasoning blocks and sends "" (never null) on tool-call turns', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'I should check the weather.' },
          { type: 'tool-call', id: CallId('call-1'), name: 'get_weather', arguments: '{"city":"Paris"}' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{
      role: 'assistant',
      // OpenAI history has no reasoning passback; tool-call turns send "".
      content: '',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
    }])
  })

  it('serializes parallel tool calls in order', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'tool-call', id: CallId('a'), name: 'one', arguments: '{}' },
          { type: 'tool-call', id: CallId('b'), name: 'two', arguments: '{}' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    const assistant = wire[0] as { tool_calls: { id: string }[] }
    expect(assistant.tool_calls.map(call => call.id)).toEqual(['a', 'b'])
  })

  it('turns tool results into role:tool messages', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [{ type: 'text', text: 'Sunny 22C' }],
        }],
        source: { kind: 'user' },
      }),
    ])
    expect(wire).toEqual([{ role: 'tool', tool_call_id: 'call-1', content: 'Sunny 22C' }])
  })
})

describe('reasoningEffortWire', () => {
  it('maps the harness vocabulary onto OpenAI wire levels', () => {
    expect(reasoningEffortWire(undefined)).toBeUndefined()
    expect(reasoningEffortWire('off')).toBeUndefined()
    expect(reasoningEffortWire('low')).toBe('low')
    expect(reasoningEffortWire('high')).toBe('high')
    expect(reasoningEffortWire('max')).toBe('high')
  })
})

describe('serializeRequest', () => {
  it('builds the minimal streaming body with usage reporting', () => {
    expect(serializeRequest(request())).toEqual({
      model: 'gpt-4o',
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('emits max_tokens for classic models and max_completion_tokens for reasoning models', () => {
    const classic = serializeRequest(request({ model: 'gpt-4o', maxTokens: 4096 }))
    expect(classic.max_tokens).toBe(4096)
    expect(classic.max_completion_tokens).toBeUndefined()
    const reasoning = serializeRequest(request({ model: 'o4-mini', maxTokens: 4096 }))
    expect(reasoning.max_completion_tokens).toBe(4096)
    expect(reasoning.max_tokens).toBeUndefined()
    const gpt5 = serializeRequest(request({ model: 'gpt-5', maxTokens: 4096 }))
    expect(gpt5.max_completion_tokens).toBe(4096)
  })

  it('maps effort defaults onto reasoning_effort and omits off', () => {
    const high = serializeRequest(request({ reasoningEffort: ReasoningEffortId('high') }))
    expect(high.reasoning_effort).toBe('high')
    const off = serializeRequest(request({ reasoningEffort: ReasoningEffortId('off') }))
    expect(off.reasoning_effort).toBeUndefined()
    const fromDefaults = serializeRequest(request(), { reasoningEffort: 'max' })
    expect(fromDefaults.reasoning_effort).toBe('high')
  })

  it('never sends reasoning_effort for session-title calls', () => {
    const title = serializeRequest(request({ purpose: 'session-title', reasoningEffort: ReasoningEffortId('high') }))
    expect(title.reasoning_effort).toBeUndefined()
  })

  it('serializes tools, temperature, and stop sequences', () => {
    const wire = serializeRequest(request({
      temperature: 0.2,
      stop: ['END'],
      tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {} } }],
    }))
    expect(wire.temperature).toBe(0.2)
    expect(wire.stop).toEqual(['END'])
    expect(wire.tools).toEqual([{
      type: 'function',
      function: { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {} } },
    }])
  })

  it('rejects image content with UNSUPPORTED_CONTENT', () => {
    const message: Message = createUserMessage({
      content: [{
        type: 'image',
        attachment: { type: 'builtin', id: 'a', ref: 'b' } as never,
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    expect(() => serializeMessages([message])).toThrow(/image content/)
  })
})
