import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ApiProxy } from './api/index.ts'

const ORIGIN = 'x-anton-mail-forward-origin'
const TIME = 'x-anton-mail-forward-time'
const NONCE = 'x-anton-mail-forward-nonce'
const MAC = 'x-anton-mail-forward-mac'

/** Private bridge assertion checker: raw Origin and loopback are never credentials. */
export interface AgentMailVerifiedApi extends ApiProxy {
  /** Kept private to the carrier: not a browser-callable RPC method. */
  verifyAgentMailOrigin(request: Request): string | undefined
}

export class AgentMailForwardVerifier {
  private readonly seen = new Map<string, number>()
  constructor(private readonly key: Uint8Array | undefined, private readonly now = Date.now) {}

  verify(request: Request): string | undefined {
    const target = new URL(request.url)
    if (!this.key || this.key.length !== 32 || request.method !== 'POST'
      || !/^\/api\/agentMail\.[A-Za-z]+$/.test(target.pathname) || target.search !== ''
      // The node:http carrier deliberately maps every inbound URL to this
      // synthetic authority. The MAC, not the request URL, proves the bridge.
      || target.origin !== 'http://dsh.internal') return undefined
    const origin = request.headers.get(ORIGIN)
    const timestamp = request.headers.get(TIME)
    const nonce = request.headers.get(NONCE)
    const mac = request.headers.get(MAC)
    if (!origin || !timestamp || !nonce || !mac
      || !/^(0|[1-9][0-9]{0,15})$/.test(timestamp)
      || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(mac)) return undefined
    const when = Number(timestamp)
    if (!Number.isSafeInteger(when) || Math.abs(this.now() - when) > 30_000) return undefined
    let url: URL
    try { url = new URL(origin) } catch { return undefined }
    if (url.origin !== origin || url.protocol !== 'http:' || url.port !== '3742'
      || !['antoncode.localhost', 'localhost', '127.0.0.1'].includes(url.hostname)) return undefined
    const hmac = createHmac('sha256', this.key)
    for (const field of ['antonmail-forward-v1', 'POST', target.pathname, origin, timestamp, nonce]) {
      const bytes = Buffer.from(field, 'utf8')
      const length = Buffer.alloc(4)
      length.writeUInt32BE(bytes.length)
      hmac.update(length).update(bytes)
    }
    const expected = hmac.digest()
    if (!timingSafeEqual(expected, Buffer.from(mac, 'hex'))) return undefined
    for (const [id, expires] of this.seen) if (expires <= this.now()) this.seen.delete(id)
    if (this.seen.has(nonce) || this.seen.size >= 128) return undefined
    this.seen.set(nonce, this.now() + 30_000)
    return origin
  }
}
