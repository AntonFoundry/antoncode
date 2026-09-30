/** Provider-neutral messages exchanged by the Blueant live voice client. */
export type LiveVoiceClientMessage =
  | { type: 'text'; text: string }
  | { type: 'toolResponse'; id: string; name: string; result: unknown }

export interface LiveVoiceSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface LiveVoiceSession {
  receive(message: string): void
  close(): void
}

interface GeminiLiveOptions {
  apiKey: string
  model: string
  voice: string
  systemPrompt: string
  onTurn?: (user: string, assistant: string) => void
}

interface GeminiLiveSocket extends LiveVoiceSocket {
  readyState: number
}

const OPEN = 1

/**
 * Opens a Gemini Live session behind the loopback bridge. The Mac app never
 * receives the provider credential; it exchanges normalized voice events with
 * this adapter instead.
 */
export function openGeminiLive(socket: LiveVoiceSocket, options: GeminiLiveOptions): LiveVoiceSession {
  const client = socket as GeminiLiveSocket
  const endpoint = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(options.apiKey)}`
  const upstream = new WebSocket(endpoint)
  let closed = false
  let ready = false
  const pendingMessages: Record<string, unknown>[] = []
  let inboundFrames = Promise.resolve()
  let sentResponseAudio = false
  let inputTranscript = ''
  let outputTranscript = ''
  const mergeTranscript = (current: string, incoming: string): string => {
    if (incoming.startsWith(current)) return incoming
    if (current.endsWith(incoming)) return current
    return current + incoming
  }
  const noteResponseAudio = (): void => {
    if (sentResponseAudio) return
    sentResponseAudio = true
    console.info('[blueant-live] Streaming Gemini response audio')
  }

  const sendClient = (payload: Record<string, unknown>): void => {
    if (!closed && client.readyState === OPEN) client.send(JSON.stringify(payload))
  }

  const sendUpstream = (payload: Record<string, unknown>): void => {
    if (closed) return
    if (upstream.readyState === WebSocket.OPEN && ready) {
      upstream.send(JSON.stringify(payload))
      return
    }
    // Local transcription can finish before provider setup. Preserve the text
    // turn and tool replies until setupComplete arrives.
    if (pendingMessages.length >= 32) {
      sendClient({ type: 'error', message: 'Gemini setup took too long to accept text turns' })
      return
    }
    pendingMessages.push(payload)
  }

  upstream.addEventListener('open', () => {
    console.info('[blueant-live] Gemini WebSocket connected; sending setup')
    const setup = {
      setup: {
        model: `models/${options.model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } },
        },
        systemInstruction: { parts: [{ text: options.systemPrompt }] },
        tools: [{
          functionDeclarations: [{
            name: 'end_conversation',
            description: 'End the Blueant voice conversation when the user says goodbye, bye, farewell, or asks to stop or close the assistant.',
            parameters: { type: 'OBJECT', properties: {} },
          }, {
            name: 'delegate_task',
            description: 'Ask the Anton agent to search the web, consult saved context, or perform a task that needs tools. Speak its returned result to the user.',
            parameters: {
              type: 'OBJECT',
              properties: { task: { type: 'STRING', description: 'The specific question or task for Anton to perform.' } },
              required: ['task'],
            },
          }],
        }],
        outputAudioTranscription: {},
        // Blueant owns speech detection and sends completed text turns. A new
        // clientContent turn interrupts active generation without audio VAD.
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: true,
          },
          activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
        },
      },
    }
    upstream.send(JSON.stringify(setup))
    sendClient({ type: 'connecting', provider: 'gemini' })
  })

  upstream.addEventListener('message', (event) => {
    // Gemini Live can deliver control frames with the binary opcode. Decode
    // every frame in order so setupComplete releases queued text turns.
    inboundFrames = inboundFrames.then(async () => {
      const raw = await decodeGeminiFrame(event.data)
      if (raw === undefined) {
        sendClient({ type: 'error', message: 'Gemini returned an unsupported frame' })
        return
      }
      handleGeminiFrame(raw)
    }).catch((error) => {
      console.error('[blueant-live] Could not decode Gemini frame')
      sendClient({ type: 'error', message: 'Could not decode Gemini Live response' })
      if (error instanceof Error) console.error(error.message)
    })
  })

  const handleGeminiFrame = (raw: string): void => {
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      forwardGeminiFrame(raw, sendClient, noteResponseAudio)
      return
    }
    if (typeof frame === 'object' && frame !== null && 'setupComplete' in frame && !ready) {
      ready = true
      console.info('[blueant-live] Gemini setup complete')
      for (const payload of pendingMessages.splice(0)) upstream.send(JSON.stringify(payload))
    }
    let turnComplete = false
    if (typeof frame === 'object' && frame !== null) {
      const content = (frame as { serverContent?: {
        outputTranscription?: { text?: string }
        turnComplete?: boolean
      } }).serverContent
      if (content?.outputTranscription?.text) {
        outputTranscript = mergeTranscript(outputTranscript, content.outputTranscription.text)
      }
      turnComplete = Boolean(content?.turnComplete)
    }
    if (turnComplete && outputTranscript === '' && !sentResponseAudio) {
      sendClient({ type: 'error', message: 'Gemini completed without a spoken reply' })
      inputTranscript = ''
      outputTranscript = ''
      sentResponseAudio = false
      return
    }
    forwardGeminiFrame(JSON.stringify(frame), sendClient, noteResponseAudio)
    if (turnComplete) {
      options.onTurn?.(inputTranscript.trim(), outputTranscript.trim())
      inputTranscript = ''
      outputTranscript = ''
      sentResponseAudio = false
    }
  }

  upstream.addEventListener('error', () => {
    console.error('[blueant-live] Gemini WebSocket error')
    sendClient({ type: 'error', message: 'Gemini Live connection failed' })
  })

  upstream.addEventListener('close', (event) => {
    if (closed) return
    console.error('[blueant-live] Gemini WebSocket closed (' + event.code + ')')
    sendClient({ type: 'closed', code: event.code, reason: event.reason })
    closed = true
  })

  return {
    receive(message: string): void {
      if (closed) return
      let parsed: unknown
      try {
        parsed = JSON.parse(message)
      } catch {
        sendClient({ type: 'error', message: 'Invalid live voice message' })
        return
      }
      if (!isClientMessage(parsed)) {
        sendClient({ type: 'error', message: 'Unsupported live voice message' })
        return
      }
      if (parsed.type === 'text') {
        const transcript = parsed.text.trim()
        if (transcript === '') {
          sendClient({ type: 'error', message: 'Empty local transcript' })
          return
        }
        sentResponseAudio = false
        inputTranscript = transcript
        outputTranscript = ''
        sendUpstream({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: transcript }] }],
            turnComplete: true,
          },
        })
      } else {
        sendUpstream({
          toolResponse: {
            functionResponses: [{
              id: parsed.id,
              name: parsed.name,
              response: { result: parsed.result },
            }],
          },
        })
      }
    },
    close(): void {
      if (closed) return
      closed = true
      upstream.close()
    },
  }
}

function forwardGeminiFrame(
  raw: string,
  send: (payload: Record<string, unknown>) => void,
  noteResponseAudio: () => void,
): void {
  let root: unknown
  try {
    root = JSON.parse(raw) as Record<string, unknown>
  } catch {
    send({ type: 'error', message: 'Gemini returned invalid JSON' })
    return
  }

  if (root.setupComplete !== undefined) {
    send({ type: 'ready', provider: 'gemini' })
  }
  if (root.error !== undefined) {
    const error = root.error as { message?: unknown; code?: unknown }
    const code = typeof error.code === 'number' ? ' (' + error.code + ')' : ''
    send({
      type: 'error',
      message: typeof error.message === 'string' ? error.message : 'Gemini setup failed' + code,
    })
    return
  }
  const calls = root.toolCall?.functionCalls
  if (Array.isArray(calls)) {
    for (const call of calls) {
      send({ type: 'toolCall', id: call.id ?? '', name: call.name ?? '', args: call.args ?? {} })
    }
  }

  const content = root.serverContent
  if (!content) return

  const parts = content.modelTurn?.parts ?? []
  for (const part of parts) {
    const inline = part.inlineData
    if (inline?.data) {
      noteResponseAudio()
      send({
        type: 'audio',
        data: inline.data,
        mimeType: inline.mimeType ?? 'audio/pcm;rate=24000',
        sampleRate: 24_000,
      })
    }
    if (typeof part.text === 'string' && !part.thought) {
      send({ type: 'text', text: part.text })
    }
  }

  const input = content.inputTranscription
  if (input?.text) send({ type: 'transcript', role: 'user', text: input.text, finished: Boolean(input.finished) })
  const output = content.outputTranscription
  if (output?.text) send({ type: 'transcript', role: 'assistant', text: output.text, finished: Boolean(output.finished) })
  if (content.interrupted) send({ type: 'interrupted' })
  if (content.turnComplete) send({ type: 'turnComplete' })

}

async function decodeGeminiFrame(data: unknown): Promise<string | undefined> {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }
  if (data instanceof Blob) return await data.text()
  return undefined
}

function isClientMessage(value: unknown): value is LiveVoiceClientMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  if (message.type === 'text') return typeof message.text === 'string'
  return message.type === 'toolResponse'
    && typeof message.id === 'string'
    && typeof message.name === 'string'
    && 'result' in message
}
