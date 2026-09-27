import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Agent-owned Chrome, driven over the DevTools Protocol. The profile dir is
 * isolated from the user's daily browsing profile (own cookies, own sign-ins),
 * the window is visible and grabbable at any moment, and the debug port is
 * loopback-only on an ephemeral port discovered through DevToolsActivePort.
 * Actions execute through the bridge and return their page result directly.
 */

const chromeBinary = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export interface ChromeReadResult {
  title: string
  url: string
  text: string
  forms: Array<{
    tag: string
    type?: string
    id?: string
    name?: string
    placeholder?: string
    label?: string
    value?: string
    options?: string[]
  }>
  buttons: string[]
}

export interface ChromeActRequest {
  action: 'fill' | 'click'
  selector: string
  value?: string
  /** Human-readable page title included in action results. */
  pageTitle: string
}

type CdpMessage = {
  id?: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: Record<string, unknown>
  error?: { message: string }
}

export class ChromeManager {
  private process: Bun.Subprocess | undefined
  private ws: WebSocket | undefined
  private port = 0
  private browserWsPath = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  private sessions = new Map<string, string>() // targetId -> CDP sessionId
  activeTargetId = ''

  get running(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN
  }

  /** Launch (or attach to) the agent Chrome; resolves the ephemeral debug port. */
  async ensureRunning(): Promise<void> {
    if (this.running) return
    const profileDir = join(homedir(), 'Library', 'Application Support', 'Anton', 'anton-chrome')
    mkdirSync(profileDir, { recursive: true })
    if (!existsSync(chromeBinary)) throw new Error('Google Chrome is not installed at /Applications')
    // Attach first: a Chrome from a previous bridge run may still be up, and
    // spawning a second instance only triggers the singleton handoff.
    if (await this.tryAttach(profileDir)) return
    this.process = Bun.spawn([chromeBinary, `--user-data-dir=${profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check'], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    // DevToolsActivePort: [port, browser ws path], written once the socket is
    // up. Liveness uses kill(0) — awaiting process.exited here would block
    // for exactly as long as Chrome is healthy.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise(resolveTimer => setTimeout(resolveTimer, 250))
      if (await this.tryAttach(profileDir)) return
      try {
        this.process.kill(0)
      } catch {
        throw new Error('agent Chrome exited during launch')
      }
    }
    throw new Error('agent Chrome did not expose a debug port in time')
  }

  /** Read DevToolsActivePort and attach when the endpoint actually answers. */
  private async tryAttach(profileDir: string): Promise<boolean> {
    const portFile = join(profileDir, 'DevToolsActivePort')
    if (!existsSync(portFile)) return false
    const lines = readFileSync(portFile, 'utf8').trim().split('\n')
    if (lines.length < 2 || lines[0] === '' || !lines[1].startsWith('/')) return false
    const port = Number(lines[0])
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (!probe.ok) return false
    } catch {
      return false
    }
    this.port = port
    this.browserWsPath = lines[1]
    await this.connect()
    return true
  }

  private connect(): Promise<void> {
    return new Promise((resolveConnect, rejectConnect) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}${this.browserWsPath}`)
      this.ws = ws
      const guard = setTimeout(() => rejectConnect(new Error('CDP WebSocket connect timeout')), 5000)
      ws.onopen = () => { clearTimeout(guard); resolveConnect() }
      ws.onerror = () => { clearTimeout(guard); rejectConnect(new Error('CDP WebSocket failed to connect')) }
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as CdpMessage
        if (typeof message.id === 'number') {
          const waiter = this.pending.get(message.id)
          if (waiter !== undefined) {
            this.pending.delete(message.id)
            if (message.error !== undefined) waiter.reject(new Error(`CDP ${message.method ?? ''}: ${message.error.message}`))
            else waiter.resolve(message.result ?? {})
          }
        }
      }
      ws.onclose = () => {
        // Chrome quit (user closed it or crash): drop all state so the next
        // call relaunches cleanly.
        this.ws = undefined
        this.sessions.clear()
        this.activeTargetId = ''
        for (const [, waiter] of this.pending) waiter.reject(new Error('CDP connection closed'))
        this.pending.clear()
      }
    })
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const ws = this.ws
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) throw new Error('agent Chrome is not attached')
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      ws.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP ${method} timed out`))
        }
      }, 15000)
    })
  }

  private async sessionFor(targetId?: string): Promise<{ sessionId: string; targetId: string }> {
    let id = targetId ?? this.activeTargetId
    if (id === '') {
      const pages = await this.pageTargets()
      if (pages.length === 0) throw new Error('agent Chrome has no open tabs')
      id = pages[0].targetId
    }
    const existing = this.sessions.get(id)
    if (existing !== undefined) return { sessionId: existing, targetId: id }
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: id, flatten: true })
    this.sessions.set(id, String(sessionId))
    return { sessionId: String(sessionId), targetId: id }
  }

  private async pageTargets(): Promise<Array<{ targetId: string; title: string; url: string }>> {
    const { targetInfos } = await this.send('Target.getTargets')
    const infos: Array<{ targetId: string; type: string; title: string; url: string }> = Array.isArray(targetInfos)
      ? (targetInfos as Array<{ targetId: string; type: string; title: string; url: string; attached: boolean }>)
      : []
    return infos.filter(target => target.type === 'page').map(({ targetId, title, url }) => ({ targetId, title, url }))
  }

  /** Ask tier: open a URL in a new tab of the agent profile (or navigate the active tab when `reuse`). */
  async openUrl(url: string, reuse = false): Promise<{ title: string }> {
    await this.ensureRunning()
    let targetId: string
    if (reuse && this.activeTargetId !== '') {
      const { sessionId } = await this.sessionFor()
      await this.send('Page.navigate', { url }, sessionId)
      targetId = this.activeTargetId
    } else {
      const { targetId: created } = await this.send('Target.createTarget', { url })
      targetId = String(created)
    }
    this.activeTargetId = targetId
    // Give the page a beat to set its title, then report it.
    await new Promise(resolveTimer => setTimeout(resolveTimer, 800))
    try {
      const { sessionId } = await this.sessionFor(targetId)
      const { result } = await this.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId)
      return { title: String((result as { value?: unknown })?.value ?? '') }
    } catch {
      return { title: '' }
    }
  }

  /** Ask tier: read the active tab — title, URL, visible text, and a form outline. */
  async readActive(): Promise<ChromeReadResult> {
    await this.ensureRunning()
    const { sessionId } = await this.sessionFor()
    const outline = `(() => {
      const fields = [...document.querySelectorAll('input, select, textarea')].filter(el => {
        const style = getComputedStyle(el); const rect = el.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0
      }).slice(0, 40)
      const labels = new Map([...document.querySelectorAll('label[for]')].map(l => [l.getAttribute('for'), l.innerText.trim()]))
      const forms = fields.map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type !== undefined ? el.type : undefined,
        id: el.id || undefined,
        name: el.name || undefined,
        placeholder: el.placeholder || undefined,
        label: labels.get(el.id) || (el.closest('label') ? el.closest('label').innerText.trim() : undefined) || el.getAttribute('aria-label') || undefined,
        value: el.type === 'password' ? '(password set?)' : (el.value ? String(el.value).slice(0, 40) : undefined),
        options: el.tagName === 'SELECT' ? [...el.options].slice(0, 12).map(o => o.text) : undefined,
      }))
      const buttons = [...document.querySelectorAll('button, input[type=submit], [role=button]')].filter(el => {
        const style = getComputedStyle(el); const rect = el.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0
      }).slice(0, 20).map(el => el.innerText || el.value || el.getAttribute('aria-label') || '')
      const text = (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n')
      return { title: document.title, url: location.href, text: text.slice(0, 12000), forms, buttons }
    })()`
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression: outline, returnByValue: true, awaitPromise: true }, sessionId)
    if (exceptionDetails !== undefined) throw new Error(`page read failed: ${JSON.stringify(exceptionDetails).slice(0, 300)}`)
    const value = (result as { value?: ChromeReadResult }).value
    if (value === undefined) throw new Error('page read returned nothing')
    return value
  }

  /**
   * Execute a page mutation and report the observed result.
   * Fill = trusted click to focus + Input.insertText (site handlers behave);
   * click = trusted mouse press/release at the element's center.
   */
  async performAct(request: ChromeActRequest): Promise<string> {
    await this.ensureRunning()
    const { sessionId } = await this.sessionFor()
    const locate = `(el => {
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const rect = el.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName.toLowerCase(), editable: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' }
    })(document.querySelector(${JSON.stringify(request.selector)}))`
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression: locate, returnByValue: true }, sessionId)
    const located = (result as { value?: unknown }).value
    if (exceptionDetails !== undefined || located === null || located === undefined) {
      return `FAILED: no element matches '${request.selector}' on '${request.pageTitle}'`
    }
    const spot = (result as { value: { x: number; y: number; editable: boolean } }).value
    const mouse = (type: string, clickCount = 0) => this.send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount }, sessionId)
    await mouse('mousePressed', 1)
    await mouse('mouseReleased', 1)
    if (request.action === 'fill') {
      if (!spot.editable) return `FAILED: '${request.selector}' is not a fillable field on '${request.pageTitle}'`
      await new Promise(resolveTimer => setTimeout(resolveTimer, 120))
      await this.send('Input.insertText', { text: String(request.value ?? '') }, sessionId)
      // Confirm what the page actually holds now — the card promised a fill.
      const verify = await this.send('Runtime.evaluate', { expression: `String(document.querySelector(${JSON.stringify(request.selector)}).value).slice(0, 60)`, returnByValue: true }, sessionId)
      const actual = String((verify.result as { value?: unknown }).value ?? '')
      return `OK: filled '${request.selector}' with '${String(request.value ?? '').slice(0, 40)}' on '${request.pageTitle}' (field now: '${actual}')`
    }
    return `OK: clicked '${request.selector}' on '${request.pageTitle}'`
  }

  async shutdown(): Promise<void> {
    this.ws?.close()
    this.process?.kill()
    this.ws = undefined
    this.process = undefined
    this.sessions.clear()
    this.activeTargetId = ''
  }
}

let manager: ChromeManager | undefined

export function getChromeManager(): ChromeManager {
  if (manager === undefined) manager = new ChromeManager()
  return manager
}
