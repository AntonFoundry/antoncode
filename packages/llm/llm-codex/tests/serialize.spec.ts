import { describe, expect, it } from 'vitest'
import { CallId, ReasoningEffortId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { reasoningEffortWire, serializeInput, serializeRequest } from '../src/serialize.ts'

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'codex', model: 'gpt-5.2-codex', messages: [], ...overrides }
}

describe('serializeInput', () => {
  it('maps user text to a message item', async () => {
    const items = await serializeInput([
      createUserMessage({
        content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(items).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello world' }] }])
  })

  it('drops system messages from input (they ride as instructions)', async () => {
    const items = await serializeInput([
      createMessage({
        role: 'system', content: [{ type: 'text', text: 'be brief' }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(items).toEqual([])
  })

  it('maps assistant text and tool calls to message + function_call items', async () => {
    const items = await serializeInput([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking the weather' },
          { type: 'tool-call', id: CallId('call-1'), name: 'get_weather', arguments: '{"city":"Paris"}' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(items).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking the weather' }] },
      { type: 'function_call', call_id: 'call-1', name: 'get_weather', arguments: '{"city":"Paris"}' },
    ])
  })

  it('maps tool results to function_call_output items', async () => {
    const items = await serializeInput([
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [{ type: 'text', text: 'Sunny 22C' }],
        }],
        source: { kind: 'user' },
      }),
    ])
    expect(items).toEqual([{ type: 'function_call_output', call_id: 'call-1', output: 'Sunny 22C' }])
  })

  it('requires durable attachment storage when image input is present', async () => {
    const message: Message = createUserMessage({
      content: [{
        type: 'image',
        attachment: { type: 'builtin', id: 'a', ref: 'b' } as never,
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    await expect(serializeInput([message])).rejects.toThrow(/attachment service/)
  })

  it('resolves durable user images into Responses input_image data', async () => {
    const message: Message = createUserMessage({
      content: [
        { type: 'text', text: 'What is shown?' },
        { type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } as never },
      ],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const attachments = {
      readImage: async () => ({
        ref: { attachmentId: 'image-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
        data: new Uint8Array([1, 2, 3]),
      }),
    } as unknown as AttachmentStore
    await expect(serializeInput([message], attachments)).resolves.toEqual([{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'What is shown?' },
        { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
      ],
    }])
  })
})

describe('reasoningEffortWire', () => {
  it('maps the harness vocabulary onto Codex wire levels', () => {
    expect(reasoningEffortWire(undefined)).toBeUndefined()
    expect(reasoningEffortWire('off')).toBeUndefined()
    expect(reasoningEffortWire('low')).toBe('low')
    expect(reasoningEffortWire('high')).toBe('high')
    expect(reasoningEffortWire('max')).toBe('xhigh')
  })
})

describe('serializeRequest', () => {
  it('builds the minimal streaming body with explicit store:false', async () => {
    await expect(serializeRequest(request())).resolves.toEqual({
      model: 'gpt-5.2-codex',
      input: [],
      stream: true,
      store: false,
    })
  })

  it('moves the system prompt to instructions', async () => {
    const wire = await serializeRequest(request({ system: 'be brief' }))
    expect(wire.instructions).toBe('be brief')
    expect(wire.input).toEqual([])
  })

  it('emits reasoning effort + auto summary', async () => {
    const wire = await serializeRequest(request({ reasoningEffort: ReasoningEffortId('high') }))
    expect(wire.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    const off = await serializeRequest(request({ reasoningEffort: ReasoningEffortId('off') }))
    expect(off.reasoning).toBeUndefined()
  })

  it('serializes tools as strict:false functions', async () => {
    const wire = await serializeRequest(request({
      tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {} } }],
    }))
    expect(wire.tools).toEqual([{
      type: 'function',
      name: 'bash',
      description: 'run a command',
      parameters: { type: 'object', properties: {} },
      strict: false,
    }])
  })
})
