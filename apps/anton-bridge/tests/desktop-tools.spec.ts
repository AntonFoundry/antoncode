/**
 * The desktop-tools plugin the Anton app copies into the Harness profile:
 * registration shape, the bridge calls each tool makes, and the page outline
 * it hands the model.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/desktop-tools.ts'

interface RegisteredTool {
  name: string
  description: string
  execute: (args: Record<string, unknown>, execution: { signal?: AbortSignal }) => Promise<string>
}

/** Collect the tools an apply call registers, in registration order. */
function register(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>()
  const context = {
    tools: {
      register(tool: RegisteredTool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    effect(setup: () => () => void) {
      setup()
    },
  }
  apply(context as unknown as Parameters<typeof apply>[0])
  return tools
}

/** Stub the bridge with one canned JSON answer per call. */
function stubBridge(payload: Record<string, unknown>, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('anton desktop tools', () => {
  it('registers the browser driver and notification tools', () => {
    expect([...register().keys()]).toEqual([
      'browser_open', 'browser_read', 'browser_fill', 'browser_click', 'notify',
    ])
  })

  it('opens a URL through the bridge and reports the page title', async () => {
    const fetchMock = stubBridge({ ok: true, title: 'Sign in' })
    await expect(register().get('browser_open')!.execute(
      { url: 'https://example.com/login', reuse: true },
      {},
    )).resolves.toBe('opened in the Anton browser: Sign in')
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3742/bridge/api/chrome/open', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/login', reuse: true }),
    }))
  })

  it('renders the form outline with usable selectors', async () => {
    stubBridge({
      title: 'Sign in',
      url: 'https://example.com/login',
      text: 'Welcome back',
      forms: [
        { tag: 'input', type: 'email', id: 'email', label: 'Email', value: 'a@b.c' },
        { tag: 'input', type: 'password', id: 'pw', value: '(password set?)' },
        { tag: 'select', name: 'region', options: ['EU', 'US'] },
      ],
      buttons: ['Sign in', ''],
    })
    const outline = await register().get('browser_read')!.execute({}, {})
    expect(outline).toContain('PAGE: Sign in (https://example.com/login)')
    expect(outline).toContain("- input[type=email] #email label 'Email' value 'a@b.c' (selector: #email)")
    expect(outline).toContain('(selector: [name=region])')
    expect(outline).toContain("BUTTONS:\n- 'Sign in'")
    expect(outline).not.toContain("- ''")
  })

  it('names the page it fills, so the result is verifiable', async () => {
    const fetchMock = vi.fn(async (input: unknown) => String(input).endsWith('/chrome/read')
      ? new Response(JSON.stringify({ title: 'Sign in', url: 'https://example.com' }), { status: 200 })
      : new Response(JSON.stringify({ output: "OK: filled '#email' with 'a@b.c' on 'Sign in' (field now: 'a@b.c')" }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(register().get('browser_fill')!.execute(
      { selector: '#email', value: 'a@b.c' },
      {},
    )).resolves.toContain("field now: 'a@b.c'")
    const act = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/chrome/act'))
    expect(act).toBeDefined()
    const init = (act as unknown[])[1] as { body: string }
    expect(JSON.parse(init.body)).toMatchObject({ action: 'fill', selector: '#email', pageTitle: 'Sign in' })
  })

  it('queues a notification', async () => {
    const fetchMock = stubBridge({ id: 'notify-1', queued: true })
    await expect(register().get('notify')!.execute(
      { title: 'Build finished', body: 'The release build passed.' },
      {},
    )).resolves.toBe('Notification queued.')
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3742/bridge/api/notify', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ title: 'Build finished', body: 'The release build passed.' }),
    }))
  })

  it('reports an unreachable app instead of a transport error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('connect ECONNREFUSED') }))
    await expect(register().get('notify')!.execute({ body: 'hello' }, {}))
      .rejects.toThrow(/Anton is not running/)
  })

  it('surfaces a refused call with its status', async () => {
    stubBridge({ error: 'selector_required' }, 400)
    await expect(register().get('browser_click')!.execute({ selector: '' }, {}))
      .rejects.toThrow(/HTTP 400/)
  })
})
