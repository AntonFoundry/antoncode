/** Backend-only hook behavior and registration cleanup for the OpenCode companion. */
import { describe, expect, it, vi } from 'vitest'
import companion from '../examples/anton-harness.ts'

type PluginContext = Parameters<typeof companion.setup>[0]

function fixture(failRequestRegistration = false) {
  let generate: (event: { agent: string; system: Array<{ type: 'text'; text: string }> }) => void = () => { throw new Error('Missing generation hook') }
  let request: (event: { agent: string; kind: string; request: Request }) => Promise<void> = async () => { throw new Error('Missing request hook') }
  const disposeGeneration = vi.fn(async () => {})
  const disposeRequest = vi.fn(async () => {})
  const ctx: PluginContext = {
    session: {
      async hook(name, callback) {
        if (name === 'generate') {
          generate = callback as typeof generate
          return { dispose: disposeGeneration }
        }
        if (failRequestRegistration) throw new Error('Request hook unavailable')
        request = callback as typeof request
        return { dispose: disposeRequest }
      },
    },
  }
  return {
    ctx,
    generate: (event: Parameters<typeof generate>[0]) => { generate(event) },
    request: (event: Parameters<typeof request>[0]) => request(event),
    disposeGeneration,
    disposeRequest,
  }
}

function httpEvent(agent = 'anton-harness', kind = 'generate', body: unknown = { tools: [{ name: 'native_read' }], tool_choice: 'auto' }) {
  return { agent, kind, request: new Request('https://example.test/responses', { method: 'POST', headers: { authorization: 'test', 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
}

describe('OpenCode transient-generation companion', () => {
  it('keeps server instructions and reinforces Harness tool requests only for the backend agent', async () => {
    const h = fixture()
    const cleanup = await companion.setup(h.ctx)
    const backend = { agent: 'anton-harness', system: [{ type: 'text' as const, text: 'Server instructions' }] }
    const regular = { agent: 'build', system: [...backend.system] }
    h.generate(backend)
    h.generate(regular)
    expect(backend.system[0]?.text).toBe('Server instructions')
    expect(backend.system[1]?.text).toContain('emit the tool request now')
    expect(regular.system).toHaveLength(1)
    await cleanup()
  })

  it('disables native selection while preserving the request body, headers, and tool declarations', async () => {
    const h = fixture()
    const cleanup = await companion.setup(h.ctx)
    const event = httpEvent()
    await h.request(event)
    expect(await event.request.json()).toEqual({ tools: [{ name: 'native_read' }], tool_choice: 'none' })
    expect(event.request.headers.get('authorization')).toBe('test')
    expect(event.request.method).toBe('POST')
    await cleanup()
  })

  it.each([['build', 'generate'], ['anton-harness', 'primary'], ['anton-harness', 'title'], ['anton-harness', 'compaction']])('leaves %s %s requests untouched', async (agent, kind) => {
    const h = fixture()
    const cleanup = await companion.setup(h.ctx)
    const event = httpEvent(agent, kind)
    const original = event.request
    await h.request(event)
    expect(event.request).toBe(original)
    await cleanup()
  })

  it('rejects malformed backend JSON without replacing the request', async () => {
    const h = fixture()
    const cleanup = await companion.setup(h.ctx)
    const event = httpEvent('anton-harness', 'generate', [])
    const original = event.request
    await expect(h.request(event)).rejects.toThrow('requires a JSON request object')
    expect(event.request).toBe(original)
    await cleanup()
  })

  it('releases the generation hook if request registration fails', async () => {
    const h = fixture(true)
    await expect(companion.setup(h.ctx)).rejects.toThrow('Request hook unavailable')
    expect(h.disposeGeneration).toHaveBeenCalledOnce()
  })

  it('awaits both hook disposers even if request disposal fails', async () => {
    const h = fixture()
    const cleanup = await companion.setup(h.ctx)
    h.disposeRequest.mockRejectedValueOnce(new Error('Request disposal failed'))
    await expect(cleanup()).rejects.toThrow('Request disposal failed')
    expect(h.disposeGeneration).toHaveBeenCalledOnce()
    expect(h.disposeRequest).toHaveBeenCalledOnce()
  })
})
