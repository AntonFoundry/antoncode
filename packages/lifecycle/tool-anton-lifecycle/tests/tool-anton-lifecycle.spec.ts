/**
 * Unit contracts of the lifecycle tools against a real local HTTP double of the Anton Bridge:
 * routing (method + path), payload passthrough, refusal surfacing, self-termination semantics,
 * environment endpoint override, and load-time misconfiguration failure.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply, type Config } from '../src/index.ts'

/** One recorded bridge request. */
interface RecordedRequest {
  method: string
  path: string
}

let server: Server | undefined

afterEach(async () => {
  const closing = server
  server = undefined
  if (closing !== undefined) {
    // fetch keeps its socket alive; without this the close callback waits out the keep-alive.
    closing.closeAllConnections()
    await new Promise<void>(resolve => { closing.close(() => resolve()) })
  }
})

type Handler = (request: IncomingMessage, response: ServerResponse) => void

/** Start a local HTTP double of the bridge and return its base URL plus the request recorder. */
async function startBridge(handler: Handler): Promise<{ base: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  server = createServer((request, response) => {
    requests.push({ method: request.method ?? '', path: request.url ?? '' })
    handler(request, response)
  })
  await new Promise<void>(resolve => { server!.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, requests }
}

const OK_JSON: Handler = (_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ ok: true }))
}

function stubExec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

interface RegisteredTool {
  name: string
  execute: (args: unknown, exec: ToolRunContext) => Promise<unknown>
}

/** Register the plugin against a capturing tool registry double. */
function register(config: Config): RegisteredTool[] {
  const registered: RegisteredTool[] = []
  const ctx = { tools: { register: (definition: unknown) => registered.push(definition as RegisteredTool) } }
  apply(ctx as unknown as Context, config)
  return registered
}

describe('tool registration and configuration', () => {
  it('registers all four tools by default', () => {
    expect(register({}).map(tool => tool.name)).toEqual(['anton_status', 'anton_start', 'anton_stop', 'anton_restart'])
  })

  it('omits tools whose enable flag is false', () => {
    const names = register({
      statusToolEnabled: false,
      startToolEnabled: false,
      stopToolEnabled: false,
      restartToolEnabled: false,
    }).map(tool => tool.name)
    expect(names).toEqual([])
  })

  it('fails loud at registration when the endpoint is not HTTP(S)', () => {
    expect(() => register({ bridgeEndpoint: 'ftp://127.0.0.1:3742' })).toThrow('must use http or https')
  })

  it('honors the environment endpoint override over the configured value', async () => {
    const { base } = await startBridge(OK_JSON)
    const previous = process.env.ANTON_BRIDGE_ENDPOINT
    process.env.ANTON_BRIDGE_ENDPOINT = base
    try {
      const [status] = register({ bridgeEndpoint: 'http://127.0.0.1:1' })
      const result = await status!.execute({}, stubExec()) as { ok: boolean }
      expect(result.ok).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.ANTON_BRIDGE_ENDPOINT
      else process.env.ANTON_BRIDGE_ENDPOINT = previous
    }
  })
})

describe('bridge round-trips', () => {
  it('anton_status routes GET to the status path and passes the payload through', async () => {
    const status = { bridge: { status: 'ok' }, harness: { running: true } }
    const { base, requests } = await startBridge((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(status))
    })
    const [tool] = register({ bridgeEndpoint: base })
    await expect(tool!.execute({}, stubExec())).resolves.toEqual(status)
    expect(requests).toEqual([{ method: 'GET', path: '/bridge/api/status' }])
  })

  it.each([
    { name: 'anton_start', path: '/bridge/api/harness/start' },
    { name: 'anton_stop', path: '/bridge/api/harness/stop' },
    { name: 'anton_restart', path: '/bridge/api/harness/restart' },
  ])('$name routes POST to its control path', async ({ name, path }) => {
    const { base, requests } = await startBridge(OK_JSON)
    const [tool] = register({ bridgeEndpoint: base }).filter(candidate => candidate.name === name)
    await tool!.execute({}, stubExec())
    expect(requests).toEqual([{ method: 'POST', path }])
  })

  it('a non-OK answer surfaces loud with the status and body', async () => {
    const { base } = await startBridge((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'externally managed' }))
    })
    const [tool] = register({ bridgeEndpoint: base })
    await expect(tool!.execute({}, stubExec())).rejects.toThrow('503')
  })

  it('an unreachable bridge fails with an error naming the endpoint', async () => {
    const [tool] = register({ bridgeEndpoint: 'http://127.0.0.1:1' })
    await expect(tool!.execute({}, stubExec())).rejects.toThrow('http://127.0.0.1:1')
  })
})

describe('self-terminating calls', () => {
  it('restart reports requested when our own death kills the request mid-call', async () => {
    // A socket destroyed without an answer is what the real bridge produces when it stops this
    // very process during the call.
    const { base } = await startBridge((_request, response) => { response.destroy() })
    const [, , , restart] = register({ bridgeEndpoint: base })
    await expect(restart!.execute({}, stubExec())).resolves.toEqual(expect.objectContaining({ status: 'restart_requested' }))
  })

  it('stop reports requested when our own death kills the request mid-call', async () => {
    const { base } = await startBridge((_request, response) => { response.destroy() })
    const [, , stop] = register({ bridgeEndpoint: base })
    await expect(stop!.execute({}, stubExec())).resolves.toEqual(expect.objectContaining({ status: 'stop_requested' }))
  })

  it('a refused restart still throws instead of masquerading as success', async () => {
    const { base } = await startBridge((_request, response) => {
      response.writeHead(409, { 'content-type': 'text/plain' })
      response.end('harness not started by this bridge')
    })
    const [, , , restart] = register({ bridgeEndpoint: base })
    await expect(restart!.execute({}, stubExec())).rejects.toThrow('refused')
  })
})
