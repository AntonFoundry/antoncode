import { afterEach, describe, expect, it, vi } from 'vitest'
import { openGeminiLive } from '../src/voice-live.ts'

class FakeWebSocket extends EventTarget {
  static OPEN = 1
  readyState = 0
  sent: Record<string, unknown>[] = []

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  message(payload: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }))
  }
}

const sockets: FakeWebSocket[] = []

function connect(onTurn?: (user: string, assistant: string) => void) {
  vi.stubGlobal('WebSocket', class extends FakeWebSocket {
    constructor(_url: string) {
      super()
      sockets.push(this)
    }
  })
  const received: Record<string, unknown>[] = []
  const session = openGeminiLive({
    readyState: 1,
    send(data: string) { received.push(JSON.parse(data)) },
    close() {},
  }, {
    apiKey: 'test-key', model: 'gemini-test', voice: 'Aoede', systemPrompt: 'Speak', onTurn,
  })
  return { session, upstream: sockets.at(-1)!, received }
}

afterEach(() => {
  sockets.length = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Blueant Gemini Live bridge', () => {
  it('holds a completed local text turn until Gemini setup completes', async () => {
    const { session, upstream } = connect()
    session.receive(JSON.stringify({ type: 'text', text: 'Hey Blueant, what time is it?' }))
    upstream.open()
    expect(upstream.sent[0]).toMatchObject({ setup: { model: 'models/gemini-test' } })
    expect(upstream.sent[0]).toHaveProperty('setup.tools.0.functionDeclarations.1.name', 'delegate_task')
    expect(upstream.sent[0]).toHaveProperty(
      'setup.realtimeInputConfig.automaticActivityDetection.disabled', true,
    )
    upstream.message({ setupComplete: {} })
    await vi.waitFor(() => expect(upstream.sent).toHaveLength(2))
    expect(upstream.sent.slice(1)).toEqual([
      { clientContent: { turns: [{ role: 'user', parts: [{ text: 'Hey Blueant, what time is it?' }] }], turnComplete: true } },
    ])
    session.close()
  })

  it('forwards reply audio, completes a transcript turn, and returns delegated work', async () => {
    const onTurn = vi.fn()
    const { session, upstream, received } = connect(onTurn)
    upstream.open()
    upstream.message({ setupComplete: {} })
    session.receive(JSON.stringify({ type: 'text', text: 'Where is my file?' }))
    upstream.message({ toolCall: { functionCalls: [{ id: 'call-1', name: 'delegate_task', args: { task: 'find file' } }] } })
    session.receive(JSON.stringify({ type: 'toolResponse', id: 'call-1', name: 'delegate_task', result: 'Found it' }))
    upstream.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'pcm' } }] }, outputTranscription: { text: 'I found it.' }, turnComplete: true } })
    await vi.waitFor(() => expect(onTurn).toHaveBeenCalledWith('Where is my file?', 'I found it.'))
    expect(received).toContainEqual(expect.objectContaining({ type: 'audio', data: 'pcm' }))
    expect(received).toContainEqual(expect.objectContaining({ type: 'toolCall', name: 'delegate_task' }))
    expect(upstream.sent).toContainEqual({
      toolResponse: { functionResponses: [{ id: 'call-1', name: 'delegate_task', response: { result: 'Found it' } }] },
    })
    session.close()
  })

  it('reports a silent Gemini turn without sending the local transcript twice', async () => {
    const { session, upstream, received } = connect()
    upstream.open()
    upstream.message({ setupComplete: {} })
    await vi.waitFor(() => expect(upstream.sent).toHaveLength(1))
    session.receive(JSON.stringify({ type: 'text', text: 'What time is it?' }))
    upstream.message({ serverContent: { turnComplete: true } })
    await vi.waitFor(() => expect(received).toContainEqual({ type: 'error', message: 'Gemini completed without a spoken reply' }))
    expect(upstream.sent.filter(frame => 'clientContent' in frame)).toHaveLength(1)
    session.close()
  })
})
