import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { consentMac } from '../src/consent-challenges.ts'
import { signForwardedMailRequest } from '../src/consent-forward.ts'

const seed = randomBytes(32)
const time = 1_792_748_000_000
const nonce = 'a'.repeat(32)
const target = new URL('http://127.0.0.1:3080/api/agentMail.inbox')
const request = (origin: string | null, path = '/api/agentMail.inbox', method = 'POST') => new Request(
  `http://antoncode.localhost:3742${path}`, {
    method, headers: {
      ...(origin === null ? {} : { origin }),
      'x-anton-mail-forward-origin': 'http://evil.test',
      'x-anton-mail-forward-time': '0',
      'x-anton-mail-forward-nonce': 'b'.repeat(32),
      'x-anton-mail-forward-mac': 'c'.repeat(64),
      'x-anton-mail-forward-surprise': 'spoof',
    },
  },
)

it('signs only an actual same-origin Agent Mail browser POST with private seed', () => {
  const req = request('http://antoncode.localhost:3742')
  const headers = new Headers(req.headers)
  expect(signForwardedMailRequest(req, target, headers, seed, 3742, () => time, () => nonce)).toBe(true)
  expect(headers.get('x-anton-mail-forward-origin')).toBe('http://antoncode.localhost:3742')
  expect(headers.get('x-anton-mail-forward-time')).toBe(String(time))
  expect(headers.get('x-anton-mail-forward-nonce')).toBe(nonce)
  expect(headers.get('x-anton-mail-forward-mac')).toBe(consentMac(seed,
    ['antonmail-forward-v1', 'POST', '/api/agentMail.inbox', 'http://antoncode.localhost:3742', String(time), nonce]))
  expect(headers.has('x-anton-mail-forward-surprise')).toBe(false)
})

it.each([
  [null, '/api/agentMail.inbox', 'POST'],
  ['http://evil.test', '/api/agentMail.inbox', 'POST'],
  ['http://antoncode.localhost:3742', '/api/session.prompt', 'POST'],
  ['http://antoncode.localhost:3742', '/api/agentMail.inbox', 'GET'],
])('never signs origin-less, cross-site, unrelated or non-POST traffic', (origin, path, method) => {
  const req = request(origin, path, method)
  const headers = new Headers(req.headers)
  expect(signForwardedMailRequest(req, new URL(`http://127.0.0.1:3080${path}`), headers, seed, 3742,
    () => time, () => nonce)).toBe(false)
  for (const name of headers.keys()) expect(name.startsWith('x-anton-mail-forward-')).toBe(false)
})

it('cannot sign direct Host traffic, query variants, or traffic without a seed', () => {
  const direct = new Request('http://127.0.0.1:3080/api/agentMail.inbox', { method: 'POST', headers: { origin: 'http://127.0.0.1:3080' } })
  expect(signForwardedMailRequest(direct, target, new Headers(), undefined, 3742, () => time, () => nonce)).toBe(false)
  const directHeaders = new Headers(direct.headers)
  expect(signForwardedMailRequest(direct, target, directHeaders, seed, 3742, () => time, () => nonce)).toBe(false)
  const req = request('http://antoncode.localhost:3742')
  const queryTarget = new URL(`${target.href}?skip=1`)
  expect(signForwardedMailRequest(req, queryTarget, new Headers(), seed, () => time, () => nonce)).toBe(false)
})
