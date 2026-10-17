/**
 * Test helper: a scripted stand-in for the OpenCode Zen OpenAI gateway
 * (`POST /chat/completions`, `POST /responses`). Records every request
 * (method, path, headers, parsed body) and replays scripted SSE payloads, so
 * direct-transport tests assert the exact wire contract — headers, auth,
 * effort fields, and tool schemas — without touching the network.
 *
 * @module dsh-llm-opencode/mock-zen
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** One observed gateway request. */
export interface RecordedZenRequest {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

/** Scripted chat-completions turn: content deltas, then an optional tool call, then stop. */
export interface MockZenChatScript {
  /** Text deltas in order; defaults to `['pong']`. */
  text?: string[]
  /** One tool call appended after the text; absent means a plain text turn. */
  toolCall?: { id: string; name: string; arguments: string }
}

/** Scripted Responses turn: text deltas, then an optional function call. */
export interface MockZenResponsesScript {
  /** Text deltas in order; defaults to `['pong']`. */
  text?: string[]
  /** One function call appended after the text; absent means a plain text turn. */
  toolCall?: { callId: string; name: string; arguments: string }
}

export interface MockZenGatewayOptions {
  /** Expected bearer token; mismatches answer 401. */
  expectBearer?: string
  /** Per-path status override with an error envelope. */
  status?: Record<string, number>
  /** Chat script; defaults to a single `pong` text turn. */
  chat?: MockZenChatScript
  /** Responses script; defaults to a single `pong` text turn. */
  responses?: MockZenResponsesScript
  /**
   * Answer inference paths with the live free-tier gate verdict (403
   * `FreeTierError`) instead of scripted turns. Models the upstream client
   * check firing despite valid credentials.
   */
  freeTierDenial?: boolean
}

export interface MockZenGateway {
  server: Server
  url: string
  requests: RecordedZenRequest[]
  close: () => Promise<void>
}

function sse(response: ServerResponse, payloads: string[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const payload of payloads) response.write(`data: ${payload}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
}

function chatPayloads(script: MockZenChatScript): string[] {
  const out: string[] = []
  for (const text of script.text ?? ['pong']) {
    out.push(JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }))
  }
  if (script.toolCall !== undefined) {
    const call = script.toolCall
    out.push(JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: '' },
          }],
        },
      }],
    }))
    out.push(JSON.stringify({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: call.arguments } }] },
        finish_reason: 'tool_calls',
      }],
    }))
  } else {
    out.push(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
  }
  return out
}

function responsesPayloads(script: MockZenResponsesScript): string[] {
  const out: string[] = []
  for (const text of script.text ?? ['pong']) {
    out.push(JSON.stringify({ type: 'response.output_text.delta', delta: text }))
  }
  if (script.toolCall !== undefined) {
    const call = script.toolCall
    out.push(JSON.stringify({
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: call.callId, name: call.name, arguments: call.arguments },
    }))
  }
  out.push(JSON.stringify({
    type: 'response.completed',
    response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 6 } },
  }))
  return out
}

/** Serve one scripted Zen gateway on a loopback port. */
export async function mockZenGateway(script: MockZenGatewayOptions = {}): Promise<MockZenGateway> {
  const requests: RecordedZenRequest[] = []
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
      const headers: Record<string, string | string[] | undefined> = {}
      for (const [name, value] of Object.entries(request.headers)) headers[name] = value
      requests.push({ method: request.method ?? '', path: url.pathname, headers, body })
      if (script.expectBearer !== undefined
        && request.headers.authorization !== `Bearer ${script.expectBearer}`) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'bad key' } }))
        return
      }
      const override = script.status?.[url.pathname]
      if (override !== undefined) {
        response.writeHead(override, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'UpstreamError', message: `status ${override}` } }))
        return
      }
      if (script.freeTierDenial === true
        && request.method === 'POST'
        && (url.pathname === '/chat/completions' || url.pathname === '/responses')) {
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          error: {
            type: 'FreeTierError',
            message: "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
          },
        }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/chat/completions') {
        sse(response, chatPayloads(script.chat ?? {}))
        return
      }
      if (request.method === 'POST' && url.pathname === '/responses') {
        sse(response, responsesPayloads(script.responses ?? {}))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'unknown route' } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('mock Zen gateway has no address')
  return {
    server,
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}
