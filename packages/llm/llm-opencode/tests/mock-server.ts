/**
 * Test helper: a stateful in-process stand-in for the opencode HTTP API.
 * Speaks both wire generations the adapter tolerates (nested `prompt.text`
 * versus flat `text`, `{data}` envelopes versus bare payloads) under per-test
 * knobs, and records every request for shape assertions.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** The assistant side of one scripted turn. */
interface AssistantScript {
  reasoning?: string
  text?: string
  tokens?: Record<string, unknown>
  /** Wire finish marker; the adapter maps `length` to max-tokens. */
  finish?: string
  /** Terminal outcome; `failed` surfaces as a SERVER finish. */
  outcome?: 'succeeded' | 'failed'
  /**
   * Completion posture: `ok` answers idle plus assistant, `absent` answers
   * idle with no assistant message, `never` never answers idle at all.
   */
  completion?: 'ok' | 'absent' | 'never'
}

/** Knobs selecting one test's server behavior. */
export interface MockOpenCodeServerOptions {
  /** Raw model entries served from `GET /api/model`. */
  models?: unknown[]
  /** Wrap payloads in `{data}` (current generation); `false` serves bare payloads. */
  envelope?: boolean
  /** Prompt shapes the fake admits; anything else answers 400. */
  acceptShapes?: Array<'nested' | 'flat'>
  /** `GET /api/model` answers this status instead of 200. */
  modelsStatus?: number
  /** `GET /api/model` answers an empty body with 200. */
  modelsEmptyBody?: boolean
  /** `POST /api/session` answers this status instead of 200. */
  createStatus?: number
  /** `POST /api/session` answers 200 with no id. */
  createWithoutId?: boolean
  /** `POST /api/session` answers 200 with an empty id. */
  createEmptyId?: boolean
  /** `GET .../message` answers this status instead of 200. */
  messagesStatus?: number
  /** `GET .../message` answers 200 with invalid JSON. */
  messagesInvalidJson?: boolean
  /** Reject every request without an authorization header with 401. */
  requireAuth?: boolean
  /** Answer 404 to every prompt, even on live sessions. */
  staleAllPrompts?: boolean
  /** Answer 404 to the first prompt only, then serve normally. */
  staleFirstPrompt?: boolean
  /**
   * Transient-generation posture: `ok` answers 200 with the assistant text,
   * `unavailable` 404s every generate (servers without the route),
   * `empty` answers 200 without text, `error` answers 500.
   */
  generate?: 'ok' | 'unavailable' | 'empty' | 'error'
  /** Answer 404 to the first generate only, then serve normally. */
  staleFirstGenerate?: boolean
  /** Assistant side of every admitted turn. */
  assistant?: AssistantScript
}

interface RecordedRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: unknown
}

export interface MockOpenCodeServer {
  url: string
  requests: RecordedRequest[]
  /** Created server session ids, in order. */
  sessions: string[]
  /** Mark a session stale: its next prompt answers 404. */
  expire(sessionID: string): void
  close(): Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

const DEFAULT_MODELS: unknown[] = [
  {
    id: 'fledge-alpha-free',
    modelID: 'fledge-alpha-free',
    providerID: 'opencode',
    name: 'Fledge Alpha Free',
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    limit: { context: 1_048_576, output: 131_072 },
  },
]

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

/** Local opencode-server stand-in: stateful sessions with scripted completions. */
export async function mockOpenCodeServer(script: MockOpenCodeServerOptions = {}): Promise<MockOpenCodeServer> {
  const requests: RecordedRequest[] = []
  const sessions: string[] = []
  const stale = new Set<string>()
  const admittedAt = new Map<string, number>()
  const acceptShapes = script.acceptShapes ?? ['nested', 'flat']
  const assistant: AssistantScript = { text: 'pong', ...script.assistant }
  const generateMode = script.generate ?? 'ok'
  let seq = 0
  let promptCount = 0
  let generateCount = 0

  const wrap = (payload: unknown): unknown =>
    (script.envelope ?? true) && payload !== undefined ? { data: payload } : payload

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      let body: unknown
      try {
        body = raw.length > 0 ? JSON.parse(raw) as unknown : undefined
      } catch {
        body = undefined
      }
      requests.push({ method: request.method ?? '', path: url.pathname, headers: request.headers, body })
      if (script.requireAuth === true && request.headers.authorization === undefined) {
        send(response, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/model') {
        if (script.modelsStatus !== undefined) {
          send(response, script.modelsStatus, { message: 'denied' })
          return
        }
        if (script.modelsEmptyBody === true) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('')
          return
        }
        send(response, 200, wrap(script.models ?? DEFAULT_MODELS))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/session') {
        if (script.createStatus !== undefined) {
          send(response, script.createStatus, { message: 'no sessions today' })
          return
        }
        seq += 1
        const id = `ses_test${String(seq).padStart(3, '0')}`
        sessions.push(id)
        const created = script.createWithoutId === true
          ? { projectID: 'prj_x' }
          : script.createEmptyId === true
            ? { id: '', projectID: 'prj_x' }
            : { id, projectID: 'prj_x', location: { directory: '/tmp/test' } }
        send(response, 200, wrap(created))
        return
      }
      const generateMatch = request.method === 'POST'
        ? /^\/api\/session\/([^/]+)\/generate$/.exec(url.pathname)
        : null
      if (generateMatch !== null) {
        const id = generateMatch[1] ?? ''
        generateCount += 1
        if (
          generateMode === 'unavailable'
          || (script.staleFirstGenerate === true && generateCount === 1)
          || stale.has(id)
          || !sessions.includes(id)
        ) {
          send(response, 404, { message: 'session not found' })
          return
        }
        if (generateMode === 'error') {
          send(response, 500, { message: 'generation failed' })
          return
        }
        if (generateMode === 'empty') {
          send(response, 200, wrap({}))
          return
        }
        send(response, 200, wrap({ text: assistant.text ?? 'pong' }))
        return
      }
      const promptMatch = request.method === 'POST'
        ? /^\/api\/session\/([^/]+)\/prompt$/.exec(url.pathname)
        : null
      if (promptMatch !== null) {        const id = promptMatch[1] ?? ''
        promptCount += 1
        if (
          script.staleAllPrompts === true
          || (script.staleFirstPrompt === true && promptCount === 1)
          || stale.has(id)
          || !sessions.includes(id)
        ) {
          send(response, 404, { message: 'session not found' })
          return
        }
        const shape = typeof body === 'object' && body !== null && 'prompt' in body ? 'nested' : 'flat'
        if (!acceptShapes.includes(shape)) {
          send(response, 400, { message: 'Missing key\n  at ["text"]' })
          return
        }
        admittedAt.set(id, Date.now())
        send(response, 200, wrap({ id: 'msg_test', sessionID: id, type: 'user' }))
        return
      }
      const messagesMatch = request.method === 'GET'
        ? /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname)
        : null
      if (messagesMatch !== null) {
        const id = messagesMatch[1] ?? ''
        if (!sessions.includes(id)) {
          send(response, 404, { message: 'session not found' })
          return
        }
        if (script.messagesStatus !== undefined) {
          send(response, script.messagesStatus, { message: 'listing failed' })
          return
        }
        if (script.messagesInvalidJson === true) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('not json{{{')
          return
        }
        const at = admittedAt.get(id) ?? 0
        const now = Date.now()
        const staleUser = { id: 'msg_old', type: 'user', time: { created: 1 }, text: 'old' }
        const turn = { id: 'msg_new', type: 'user', time: { created: Math.max(at, 1) }, text: 'new' }
        const listed: unknown[] = [
          'not-a-message',
          staleUser,
          turn,
          { id: 'msg_notime', type: 'user', text: 'timeless' },
          { id: 'msg_badtime', type: 'user', time: { created: 'soon' }, text: 'nonsense' },
        ]
        if (assistant.completion !== 'never' && at > 0) {
          if (assistant.completion !== 'absent') {
            const content: unknown[] = []
            if (assistant.reasoning !== undefined) content.push({ type: 'reasoning', text: assistant.reasoning })
            if (assistant.text !== undefined) content.push({ type: 'text', text: assistant.text })
            listed.push({
              id: 'msg_asst',
              type: 'assistant',
              time: { created: now, completed: now },
              model: { id: 'fledge-alpha-free', providerID: 'opencode' },
              content,
              ...(assistant.tokens === undefined ? {} : { tokens: assistant.tokens }),
              finish: assistant.finish ?? 'stop',
            })
          }
          listed.push({ id: 'msg_idle', type: 'idle', time: { created: now }, outcome: assistant.outcome ?? 'succeeded' })
        }
        send(response, 200, wrap(listed))
        return
      }
      send(response, 404, { message: 'unknown route' })
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    sessions,
    expire: (sessionID: string) => {
      stale.add(sessionID)
    },
    close: () => new Promise(resolve => server.close(() => {
      resolve()
    })),
  }
}
