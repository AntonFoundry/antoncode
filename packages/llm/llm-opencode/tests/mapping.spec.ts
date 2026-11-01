/**
 * Unit tests for the opencode server value mappings: model narrowing,
 * prompt rendering, turn/token/outcome reads, error text, and the
 * abort-aware poll delay. No server needed — the stream flows that consume
 * these live in `adapter.spec.ts` against the mock server.
 */

import { describe, expect, it } from 'vitest'
import {
  assistantTurn,
  errorMessage,
  generatedText,
  idleOutcome,
  reasoningFor,
  renderPrompt,
  sleep,
  toServerModel,
  variantDisplayName,
  variantFor,
  wireTokens,
} from '../src/adapter.ts'
import { createMessage, createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, type ContentBlock, type Message } from '@deepseek-ai/dsh-llm'

function userText(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

describe('toServerModel', () => {
  it('reads the current model-info shape', () => {
    expect(toServerModel({
      id: 'muse-spark-1.3-contributor-free',
      providerID: 'opencode',
      name: 'Muse Spark',
      cost: [{ input: 0, output: 0 }],
      limit: { context: 200_000 },
      variants: [{ id: 'low' }, { id: 'high' }, { id: 'low' }, { id: '' }, 42],
    })).toEqual({
      id: 'muse-spark-1.3-contributor-free',
      providerID: 'opencode',
      name: 'Muse Spark',
      contextWindow: 200_000,
      variants: ['low', 'high'],
    })
  })

  it('reads the released model shape and defaults the name', () => {
    expect(toServerModel({ modelID: 'fledge-alpha-free', providerID: 'opencode' })).toEqual({
      id: 'fledge-alpha-free',
      providerID: 'opencode',
      name: 'fledge-alpha-free',
      variants: [],
    })
  })

  it('rejects malformed and paid entries', () => {
    expect(toServerModel(undefined)).toBeUndefined()
    expect(toServerModel({})).toBeUndefined()
    expect(toServerModel({ id: '', providerID: 'opencode' })).toBeUndefined()
    expect(toServerModel({ id: 'x', providerID: '' })).toBeUndefined()
    expect(toServerModel({ id: 'paid', providerID: 'opencode', cost: [{ input: 1.25, output: 0 }] })).toBeUndefined()
    expect(toServerModel({ id: 'paid', providerID: 'opencode', cost: { input: 0, output: 4.25 } })).toBeUndefined()
    expect(toServerModel({ id: 'weird', providerID: 'opencode', cost: 'free!' })).toBeUndefined()
    expect(toServerModel({ id: 'mixed', providerID: 'opencode', cost: ['free!'] })).toBeUndefined()
  })

  it('treats missing cost as free and ignores unusable context limits', () => {
    expect(toServerModel({ id: 'a', providerID: 'opencode', name: '' })?.contextWindow).toBeUndefined()
    expect(toServerModel({ id: 'b', providerID: 'opencode', limit: { context: 0 } })?.contextWindow).toBeUndefined()
    expect(toServerModel({ id: 'c', providerID: 'opencode', limit: { context: -5 } })?.contextWindow).toBeUndefined()
    expect(toServerModel({ id: 'd', providerID: 'opencode', limit: { context: 'lots' } })?.contextWindow)
      .toBeUndefined()
    expect(toServerModel({ id: 'e', providerID: 'opencode', limit: { context: 1.5 } })?.contextWindow).toBeUndefined()
  })
})

describe('variantDisplayName', () => {
  it('capitalizes variant ids for the picker', () => {
    expect(variantDisplayName('low')).toBe('Low')
    expect(variantDisplayName('xhigh')).toBe('Extra High')
    expect(variantDisplayName('')).toBe('')
  })
})

describe('reasoningFor', () => {
  it('returns no metadata without advertised variants', () => {
    expect(reasoningFor([])).toBeUndefined()
  })

  it('exposes one effort per server variant with no pinned default', () => {
    expect(reasoningFor(['low', 'high'])).toEqual({
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' },
      ],
    })
  })
})

describe('variantFor', () => {
  it('omits the variant for default and off efforts', () => {
    expect(variantFor(undefined, ['low', 'high'])).toBeUndefined()
    expect(variantFor('off', ['low', 'high'])).toBeUndefined()
  })

  it('passes advertised variants through verbatim', () => {
    expect(variantFor('xhigh', ['low', 'xhigh'])).toBe('xhigh')
  })

  it('rejects efforts no variant advertises', () => {
    expect(() => variantFor('ultra', ['low', 'high'])).toThrow(/ultra.*low, high/)
    expect(() => variantFor('low', [])).toThrow(/no variants/)
  })
})

describe('generatedText', () => {
  it('reads transient text from both envelopes', () => {
    expect(generatedText({ data: { text: 'hi' } })).toBe('hi')
    expect(generatedText({ text: 'hi' })).toBe('hi')
    expect(generatedText({ data: 'hi' })).toBe('hi')
    expect(generatedText(undefined)).toBeUndefined()
    expect(generatedText({ data: {} })).toBeUndefined()
    expect(generatedText({ data: { text: 42 } })).toBeUndefined()
  })
})

describe('renderPrompt', () => {
  it('renders system plus a role-labeled transcript', () => {
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: 'hi there' }],
      source: { provider: 'opencode', model: 'm' },
    })
    expect(renderPrompt('be brief', [userText('hello'), assistant])).toBe(
      'System: be brief\n\nUser: hello\n\nAssistant: hi there',
    )
  })

  it('skips empty system prompts and quotes tool traffic as text', () => {
    const toolCall = createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'search', arguments: '{"q":"x"}' }],
      source: { provider: 'test', model: 'test' },
    })
    const toolResult = createToolResultMessage({
      callId: ToolCallId('call_1'),
      content: [{ type: 'text', text: 'found it' }],
      isError: true,
    })
    const systemish = createMessage({
      role: 'system',
      content: [{ type: 'reasoning', text: 'thinking' }],
      source: { kind: 'system-prompt' },
    })
    expect(renderPrompt('', [toolCall, toolResult, systemish])).toBe(
      'Assistant: [tool call search {"q":"x"}]\n\nUser: [tool result for call_1 (error)]\nfound it\n\nSystem: thinking',
    )
  })

  it('renders a quiet tool result, and rejects one carrying an image', () => {
    const quiet = createToolResultMessage({
      callId: ToolCallId('call_2'),
      content: [{ type: 'text', text: 'done' }],
      isError: false,
    })
    expect(renderPrompt(undefined, [quiet])).toBe('User: [tool result for call_2]\ndone')

    // A tool result is its own message now, so an image it carries is a
    // top-level block and is rejected like any other, where it was previously
    // nested and dropped without a word.
    const withImage = createToolResultMessage({
      callId: ToolCallId('call_3'),
      content: [
        { type: 'image', attachment: { id: 'att_9' } } as unknown as ContentBlock,
        { type: 'text', text: 'done' },
      ],
      isError: false,
    })
    expect(() => renderPrompt(undefined, [withImage])).toThrow(/image/i)
  })

  it('drops blocks with no text representation instead of failing', () => {
    const message = createUserMessage({
      content: [
        { type: 'text', text: 'kept' },
        { type: 'future-block', text: 'dropped' } as unknown as ContentBlock,
      ],
      source: { kind: 'user' },
    })
    expect(renderPrompt(undefined, [message])).toBe('User: kept')
  })

  it('rejects image attachments instead of silently dropping them', () => {
    const message = createUserMessage({
      content: [{
        type: 'image',
        attachment: { id: 'att_1' },
      } as unknown as ContentBlock],
      source: { kind: 'user' },
    })
    expect(() => renderPrompt(undefined, [message])).toThrow(/image/i)
  })
})

describe('wireTokens', () => {
  it('returns undefined for payloads without tokens', () => {
    expect(wireTokens(undefined)).toBeUndefined()
    expect(wireTokens('tokens')).toBeUndefined()
  })

  it('maps full token counts including cache and reasoning', () => {
    expect(wireTokens({ input: 10, output: 3, reasoning: 7, cache: { read: 100, write: 4 } })).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 100,
      cacheWriteTokens: 4,
      reasoningTokens: 7,
    })
  })

  it('defaults missing counts and ignores non-numeric cache halves', () => {
    expect(wireTokens({ cache: 'warm' })).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(wireTokens({ input: 1, cache: { read: 'many' } })).toEqual({ inputTokens: 1, outputTokens: 0 })
    expect(wireTokens({ cache: { write: 2 } })).toEqual({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 2 })
  })
})

describe('assistantTurn', () => {
  it('ignores non-assistant and content-free messages', () => {
    expect(assistantTurn(undefined)).toBeUndefined()
    expect(assistantTurn({ type: 'user', content: [{ type: 'text', text: 'hi' }] })).toBeUndefined()
    expect(assistantTurn({ type: 'assistant' })).toBeUndefined()
    expect(assistantTurn({ type: 'assistant', content: [{ type: 'text' }] })).toBeUndefined()
  })

  it('reads reasoning, text, usage, and the stop finish', () => {
    expect(assistantTurn({
      type: 'assistant',
      content: [
        { type: 'reasoning', text: 'hmm' },
        { type: 'text', text: 'pong' },
        42,
        { type: 'text', text: 7 },
      ],
      tokens: { input: 1, output: 2 },
      finish: 'stop',
    })).toEqual({
      reasoning: 'hmm',
      text: 'pong',
      usage: { inputTokens: 1, outputTokens: 2 },
      finish: { kind: 'stop' },
    })
  })

  it('maps a length finish to max-tokens without usage', () => {
    expect(assistantTurn({ type: 'assistant', content: [{ type: 'text', text: 'cut' }], finish: 'length' }))
      .toEqual({ reasoning: '', text: 'cut', finish: { kind: 'max-tokens' } })
  })
})

describe('idleOutcome', () => {
  it('reads the terminal outcome, defaulting to success', () => {
    expect(idleOutcome({ type: 'user' })).toBeUndefined()
    expect(idleOutcome(undefined)).toBeUndefined()
    expect(idleOutcome({ type: 'idle' })).toBe('succeeded')
    expect(idleOutcome({ type: 'idle', outcome: 'failed' })).toBe('failed')
  })
})

describe('errorMessage', () => {
  it('reads both error envelopes with a stable fallback', () => {
    expect(errorMessage(undefined)).toBe('unknown error')
    expect(errorMessage({})).toBe('unknown error')
    expect(errorMessage({ message: '' })).toBe('unknown error')
    expect(errorMessage({ message: 'denied' })).toBe('denied')
    expect(errorMessage({ error: { message: 'wrapped' } })).toBe('wrapped')
    expect(errorMessage({ error: { message: '' } })).toBe('unknown error')
  })
})

describe('sleep', () => {
  it('resolves after the delay', async () => {
    await sleep(1, new AbortController().signal)
  })

  it('rejects immediately for an already-aborted signal', async () => {
    await expect(sleep(5_000, AbortSignal.abort())).rejects.toThrow('aborted')
  })

  it('rejects when the signal aborts mid-sleep', async () => {
    const controller = new AbortController()
    const pending = sleep(5_000, controller.signal)
    setTimeout(() => { controller.abort() }, 5)
    await expect(pending).rejects.toThrow('aborted')
  })

  it('rejects with a caller-supplied abort reason unchanged', async () => {
    const controller = new AbortController()
    const pending = sleep(5_000, controller.signal)
    setTimeout(() => { controller.abort(new Error('stop now')) }, 5)
    await expect(pending).rejects.toThrow('stop now')
  })
})
