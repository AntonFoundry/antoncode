/**
 * Anton desktop tools: a visible browser the agent can drive, and desktop
 * notifications.
 *
 * The Anton app copies this module into the Harness profile as
 * `plugins/anton-desktop-tools.js`, so it loads in every session of the
 * composition. The bridge owns both resources — one Chrome process on a
 * separate profile, and the notification queue the Mac app drains — and these
 * tools translate one call into one loopback request and return what the page
 * or the queue reported.
 *
 * The browser is an isolated Chrome profile, not the user's own: no personal
 * cookies or tabs are reachable, and every action lands in a window the user
 * can see, grab, and close.
 *
 * @module anton-desktop-tools
 */

/** The bridge's loopback base; ambient builds share the app's port. */
const BRIDGE = `http://127.0.0.1:${process.env.ANTON_BRIDGE_PORT ?? '3742'}`

/** One launched tool call, carrying the caller's cancellation. */
interface ToolExecution {
  signal?: AbortSignal
}

/** One registered tool, as the Harness tools service stores it. */
interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => Array<Record<string, unknown>>
  }
  execute: (args: Record<string, unknown>, execution: ToolExecution) => Promise<string>
}

/** The slice of the plugin context this module contributes to. */
interface DesktopToolsContext {
  tools: {
    register: (tool: ToolDefinition, label?: string) => () => void
  }
  effect: (setup: () => () => void, label: string) => void
}

export const name = 'anton-desktop-tools'
export const inject = ['tools']

/** Render one tool result as plain text, the only shape these tools return. */
const text = (_args: unknown, value: unknown): Array<Record<string, unknown>> => [
  { type: 'text', text: String(value) },
]

/**
 * Call one bridge endpoint, translating a refused or unavailable bridge into
 * a message the model can act on rather than a transport stack.
 * @param path - bridge path beginning with `/bridge/api`.
 * @param init - fetch options for the call.
 * @returns the parsed JSON body.
 * @throws Error when the bridge is down or the call was refused.
 */
async function callBridge(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(`${BRIDGE}${path}`, init)
  } catch {
    throw new Error('Anton is not running, so its desktop tools are unavailable. Ask the user to open Anton.')
  }
  if (!response.ok) {
    throw new Error(`anton bridge ${path} failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
  }
  return await response.json() as Record<string, unknown>
}

/** The active tab's title, used to name a page in an action result. */
async function activePageTitle(signal?: AbortSignal): Promise<string> {
  const page = await callBridge('/bridge/api/chrome/read', { signal }).catch(() => undefined)
  return typeof page?.title === 'string' && page.title !== '' ? page.title : 'current page'
}

/**
 * Register the browser and notification tools on the injected tools service.
 * @param ctx - plugin context carrying the tools service.
 */
export function apply(ctx: DesktopToolsContext): void {
  ctx.effect(() => ctx.tools.register({
    name: 'browser_open',
    description: 'Open an http(s) URL in the visible Anton browser window (an isolated profile, not the user\'s own). The window appears on screen. Use it before browser_read to reach a page.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL to open' },
        reuse: { type: 'boolean', description: 'Navigate the current tab instead of opening a new one' },
      },
      required: ['url'],
    },
    output: { schema: { type: 'string' }, render: text },
    async execute(args, execution) {
      const body = await callBridge('/bridge/api/chrome/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: args.url, reuse: args.reuse === true }),
        signal: execution.signal,
      })
      const title = typeof body.title === 'string' ? body.title : ''
      return `opened in the Anton browser${title === '' ? '' : `: ${title}`}`
    },
  }), 'anton.desktop.browser.open')

  ctx.effect(() => ctx.tools.register({
    name: 'browser_read',
    description: 'Read the active tab of the Anton browser: page text, URL, and a form outline (fields, labels, selectors, buttons). Use it to see what a page offers before filling or clicking.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: text },
    async execute(_args, execution) {
      const page = await callBridge('/bridge/api/chrome/read', { signal: execution.signal })
      const forms = Array.isArray(page.forms) ? page.forms as Array<Record<string, unknown>> : []
      const buttons = Array.isArray(page.buttons) ? page.buttons as unknown[] : []
      const outline = forms.map((field) => {
        const bits = [
          `${String(field.tag)}${field.type === undefined ? '' : `[type=${String(field.type)}]`}`,
          field.id === undefined ? '' : `#${String(field.id)}`,
          field.name === undefined ? '' : `[name=${String(field.name)}]`,
          field.label === undefined ? (field.placeholder === undefined ? '' : `placeholder '${String(field.placeholder)}'`) : `label '${String(field.label)}'`,
          field.value === undefined ? '' : `value '${String(field.value)}'`,
        ]
        if (Array.isArray(field.options)) bits.push(`options: ${(field.options as unknown[]).map(String).join(' | ')}`)
        const selector = field.id !== undefined ? `#${String(field.id)}`
          : field.name !== undefined ? `[name=${String(field.name)}]`
            : `${String(field.tag)}${field.type === undefined ? '' : `[type=${String(field.type)}]`}`
        return `- ${bits.filter(Boolean).join(' ')} (selector: ${selector})`
      }).join('\n')
      const labels = buttons.filter((label): label is string => typeof label === 'string' && label !== '')
        .map(label => `- '${label}'`).join('\n')
      return `PAGE: ${String(page.title)} (${String(page.url)})\n\nTEXT:\n${String(page.text)}\n\nFORM FIELDS:\n${outline === '' ? '(none)' : outline}\n\nBUTTONS:\n${labels === '' ? '(none)' : labels}`
    },
  }), 'anton.desktop.browser.read')

  ctx.effect(() => ctx.tools.register({
    name: 'browser_fill',
    description: 'Fill one form field in the Anton browser. Selectors come from browser_read\'s form outline. One field per call; click the submit control with browser_click afterwards.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the field, from browser_read (e.g. #email or input[name=q])' },
        value: { type: 'string', description: 'Text to type into the field' },
      },
      required: ['selector', 'value'],
    },
    output: { schema: { type: 'string' }, render: text },
    async execute(args, execution) {
      const body = await callBridge('/bridge/api/chrome/act', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'fill',
          selector: String(args.selector),
          value: String(args.value),
          pageTitle: await activePageTitle(execution.signal),
        }),
        signal: execution.signal,
      })
      return String(body.output)
    },
  }), 'anton.desktop.browser.fill')

  ctx.effect(() => ctx.tools.register({
    name: 'browser_click',
    description: 'Click one element in the Anton browser (button, link, submit). Prefer browser_fill for every field, then one browser_click of the submit control.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click' },
      },
      required: ['selector'],
    },
    output: { schema: { type: 'string' }, render: text },
    async execute(args, execution) {
      const body = await callBridge('/bridge/api/chrome/act', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          selector: String(args.selector),
          pageTitle: await activePageTitle(execution.signal),
        }),
        signal: execution.signal,
      })
      return String(body.output)
    },
  }), 'anton.desktop.browser.click')

  ctx.effect(() => ctx.tools.register({
    name: 'notify',
    description: 'Post a macOS notification with a title and a body. Use it to report a finished background task or something the user should see now; the notification appears even while another app is frontmost.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short notification title' },
        body: { type: 'string', description: 'Notification body text' },
      },
      required: ['body'],
    },
    output: { schema: { type: 'string' }, render: text },
    async execute(args, execution) {
      await callBridge('/bridge/api/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: args.title, body: args.body }),
        signal: execution.signal,
      })
      return 'Notification queued.'
    },
  }), 'anton.desktop.notify')
}
