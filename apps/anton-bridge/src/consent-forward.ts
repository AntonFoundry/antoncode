import { randomBytes } from 'node:crypto'
import { consentMac } from './consent-challenges.ts'

export const FORWARD_HEADERS = [
  'x-anton-mail-forward-origin', 'x-anton-mail-forward-time',
  'x-anton-mail-forward-nonce', 'x-anton-mail-forward-mac',
] as const

/** Never let an inbound header masquerade as a bridge-issued assertion. */
export function scrubForwardHeaders(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith('x-anton-mail-forward-')) headers.delete(name)
  }
}

/** A qualified browser request is a same-authority Agent Mail POST with an explicit Origin. */
export function signForwardedMailRequest(
  request: Request, target: URL, headers: Headers, key: Uint8Array | undefined,
  bridgePort: number, now = Date.now, nonce = () => randomBytes(16).toString('hex'),
): boolean {
  scrubForwardHeaders(headers)
  if (!key || request.method !== 'POST' || !/^\/api\/agentMail\.[A-Za-z]+$/.test(target.pathname)
    || target.search !== '') return false
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  if (source.protocol !== 'http:' || source.port !== String(bridgePort) || origin !== source.origin
    || (source.hostname !== 'antoncode.localhost' && source.hostname !== 'localhost'
      && source.hostname !== '127.0.0.1')) return false
  const timestamp = String(now())
  const challengeNonce = nonce()
  if (!/^(0|[1-9][0-9]{0,15})$/.test(timestamp) || !/^[a-f0-9]{32}$/.test(challengeNonce)) return false
  const mac = consentMac(key, ['antonmail-forward-v1', request.method, target.pathname, origin, timestamp, challengeNonce])
  headers.set('x-anton-mail-forward-origin', origin)
  headers.set('x-anton-mail-forward-time', timestamp)
  headers.set('x-anton-mail-forward-nonce', challengeNonce)
  headers.set('x-anton-mail-forward-mac', mac)
  return true
}
