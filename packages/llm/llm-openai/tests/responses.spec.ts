import { describe, expect, it } from 'vitest'
import { CallId, createMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { serializeResponsesRequest, translateResponses } from '../src/responses.ts'

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'opencode-free', model: 'muse-spark-1.2-contributor-free', messages: [], ...overrides }
}

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

async function* payloadStream(payloads: string[]): AsyncGenerator<string> {
  yield* payloads
}

describe('serializeResponsesRequest', () => {
  it('maps system to instructions and user text to input_text items', () => {
    const wire = serializeResponsesRequest(request({
      system: 'be brief',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
    }))
    expect(wire.instructions).toBe('be brief')
    expect(wire.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
    expect(wire.stream).toBe(true)
  })

  it('expands assistant tool calls and user tool results into items', () => {
    const history: Message[] = [
      createMessage({
        role: 'assistant',
        content: [
          { type: 'tool-call', id: CallId('call-1'), name: 'read', arguments: '{"path":"a.ts"}' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
      createUserMessage({
        content: [{ type: 'tool-result', toolCallId: CallId('call-1'), content: [{ type: 'text', text: 'contents' }] }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ]
    const wire = serializeResponsesRequest(request({ messages: history }))
    expect(wire.input).toEqual([
      { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'contents' },
    ])
  })

  it('maps tools, reasoning effort, and the output cap onto the Responses fields', () => {
    const wire = serializeResponsesRequest(request({
      tools: [{ name: 'grep', description: 'search', parameters: { type: 'object' } }],
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 1234,
    }))
    expect(wire.tools).toEqual([{ type: 'function', name: 'grep', description: 'search', parameters: { type: 'object' } }])
    expect(wire.reasoning).toEqual({ effort: 'high' })
    expect(wire.max_output_tokens).toBe(1234)
  })
})

describe('translateResponses', () => {
  it('yields text deltas and closes with usage and a stop finish on response.completed', async () => {
    const payloads = [
      JSON.stringify({ type: 'response.created' }),
      JSON.stringify({ type: 'response.output_text.delta', delta: 'hello ' }),
      JSON.stringify({ type: 'response.output_text.delta', delta: 'world' }),
      JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 4, output_tokens_details: { reasoning_tokens: 2 } },
        },
      }),
    ]
    const chunks = await collect(translateResponses(payloadStream(payloads)))
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hello ' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'world' })
    expect(chunks.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 2 } })
    expect(chunks.at(-1)?.type).toBe('finish')
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    expect(chunks.filter(chunk => chunk.type === 'block-end')).toHaveLength(1)
  })

  it('emits whole function calls from their output_item.done event', async () => {
    const payloads = [
      JSON.stringify({
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
      }),
      JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 6 } } }),
    ]
    const chunks = await collect(translateResponses(payloadStream(payloads)))
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{"command":"ls"}' },
    })
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('maps the max_output_tokens incomplete reason to a max-tokens finish', async () => {
    const payloads = [
      JSON.stringify({
        type: 'response.incomplete',
        response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      }),
    ]
    const chunks = await collect(translateResponses(payloadStream(payloads)))
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'max-tokens' } })
  })

  it('aborts on the terminal error event', async () => {
    const payloads = [JSON.stringify({ type: 'error', code: 'server_error', message: 'boom' })]
    await expect(collect(translateResponses(payloadStream(payloads)))).rejects.toThrow('boom')
  })
})
