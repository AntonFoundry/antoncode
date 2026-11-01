/**
 * Upstream table guards: model-key splitting, free-tier admission, endpoint
 * and credential resolution, failure classification, and the provider-worded
 * delay parsing the cooldown policy depends on.
 */

import { describe, expect, it } from 'vitest'
import {
  allowedInPool,
  classify,
  credentialRefOf,
  endpointFor,
  formatDuration,
  parseRetryAfter,
  PROVIDERS,
  splitModelKey,
} from '@deepseek-ai/dsh-llm-vazhi'

describe('splitModelKey', () => {
  it('splits on the first slash so nested model ids survive', () => {
    expect(splitModelKey('kilo/nvidia/nemotron:free')).toEqual(['kilo', 'nvidia/nemotron:free'])
    expect(splitModelKey('zai-free/glm-4.7-flash')).toEqual(['zai-free', 'glm-4.7-flash'])
  })

  it('rejects keys without both segments', () => {
    expect(() => splitModelKey('nvidia')).toThrow(/not a provider\/model key/)
    expect(() => splitModelKey('/model')).toThrow(/not a provider\/model key/)
    expect(() => splitModelKey('provider/')).toThrow(/not a provider\/model key/)
  })
})

describe('admission rules', () => {
  it('admits only each upstream’s declared free tier', () => {
    expect(allowedInPool('kilo', 'cohere/north:free')).toBe(true)
    expect(allowedInPool('kilo', 'kilo-auto/free')).toBe(true)
    expect(allowedInPool('kilo', 'cohere/north')).toBe(false)
    expect(allowedInPool('ovh', 'anything')).toBe(true)
    expect(allowedInPool('llm7', 'anything')).toBe(true)
    expect(allowedInPool('nvidia', 'anything')).toBe(true)
    expect(allowedInPool('google', 'gemini-3.6-flash')).toBe(true)
    expect(allowedInPool('google', 'gemini-3.6-flash-lite')).toBe(true)
    expect(allowedInPool('google', 'gemini-3.6-pro')).toBe(false)
    expect(allowedInPool('google', 'gemini-pro-flash')).toBe(false)
    expect(allowedInPool('openrouter', 'vendor/model:free')).toBe(true)
    expect(allowedInPool('openrouter', 'openrouter/free')).toBe(true)
    expect(allowedInPool('openrouter', 'vendor/model')).toBe(false)
    expect(allowedInPool('ollama-cloud', 'gpt-oss:120b')).toBe(true)
    expect(allowedInPool('ollama-cloud', 'gpt-oss:20b')).toBe(false)
    expect(allowedInPool('zai-free', 'glm-4.7-flash')).toBe(true)
    expect(allowedInPool('zai-free', 'glm-4.7')).toBe(false)
  })

  it('admits nothing from an unknown upstream', () => {
    expect(allowedInPool('unknown', 'model')).toBe(false)
  })
})

describe('endpointFor', () => {
  it('reaches anonymous upstreams without a credential', () => {
    expect(endpointFor('kilo/kilo-auto/free', undefined)).toEqual({
      baseURL: 'https://api.kilo.ai/api/gateway',
      model: 'kilo-auto/free',
      headers: {},
    })
  })

  it('pins the upstream base URL from the table, never from a pool document', () => {
    expect(PROVIDERS['llm7']?.base).toBe('https://api.llm7.io/v1')
    expect(endpointFor('llm7/model', undefined)?.baseURL).toBe('https://api.llm7.io/v1')
  })

  it('sends a keyed upstream’s fixed headers beside its key', () => {
    expect(endpointFor('nvidia/model', 'nv-key')).toEqual({
      baseURL: 'https://integrate.api.nvidia.com/v1',
      model: 'model',
      headers: { 'NVCF-POLL-SECONDS': '5' },
      apiKey: 'nv-key',
    })
  })

  it('sends no fixed headers for a keyed upstream that declares none', () => {
    expect(endpointFor('google/gemini-3.6-flash', 'g-key')).toEqual({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3.6-flash',
      headers: {},
      apiKey: 'g-key',
    })
  })

  it('refuses a keyed upstream without a key and an unknown upstream outright', () => {
    expect(endpointFor('google/gemini-3.6-flash', undefined)).toBeUndefined()
    expect(endpointFor('unknown/model', 'key')).toBeUndefined()
  })

  it('names the credential reference each keyed upstream resolves', () => {
    expect(credentialRefOf('nvidia')).toBe('NVIDIA_API_KEY')
    expect(credentialRefOf('google')).toBe('GEMINI_API_KEY')
    expect(credentialRefOf('openrouter')).toBe('OPENROUTER_API_KEY')
    expect(credentialRefOf('ollama-cloud')).toBe('OLLAMA_API_KEY')
    expect(credentialRefOf('zai-free')).toBe('ZAI_API_KEY')
    expect(credentialRefOf('kilo')).toBeUndefined()
    expect(credentialRefOf('unknown')).toBeUndefined()
  })
})

describe('classify', () => {
  it('matches the first rule in cooldown order', () => {
    expect(classify('HTTP 401 unauthorized')).toMatchObject({ kind: 'auth', baseMs: 21_600_000 })
    expect(classify('403 forbidden')).toMatchObject({ kind: 'denied', baseMs: 3_600_000 })
    expect(classify('limit 5 per min')).toMatchObject({ kind: 'minute', baseMs: 60_000 })
    expect(classify('hourly budget')).toMatchObject({ kind: 'hourly', baseMs: 900_000 })
    expect(classify('daily limit reached')).toMatchObject({ kind: 'daily', baseMs: 3_600_000 })
    expect(classify('Payment required: insufficient credit')).toMatchObject({ kind: 'quota', baseMs: 3_600_000 })
    expect(classify('404 model not found')).toMatchObject({ kind: 'gone', baseMs: 3_600_000 })
    expect(classify('upstream timed out')).toMatchObject({ kind: 'slow', baseMs: 900_000 })
    expect(classify('429 too many requests')).toMatchObject({ kind: 'rate', baseMs: 30_000 })
    expect(classify('400 invalid request')).toMatchObject({ kind: 'client', baseMs: 300_000 })
    expect(classify('something unheard of')).toMatchObject({ kind: 'other', baseMs: 60_000 })
  })

  it('caps each kind at its ceiling', () => {
    expect(classify('429')).toMatchObject({ maxMs: 1_800_000 })
    expect(classify('unexpected')).toMatchObject({ maxMs: 1_800_000 })
  })

  it('reads an NVIDIA 504 as a hang rather than a client-visible gateway error', () => {
    expect(classify('  504 gateway timeout', 'nvidia')).toMatchObject({ kind: 'slow' })
    expect(classify('504 from another upstream')).toMatchObject({ kind: 'other' })
  })
})

describe('parseRetryAfter', () => {
  it('reads the header-style and prose forms in their stated unit', () => {
    expect(parseRetryAfter('retry-after: 90')).toBe(90_000)
    expect(parseRetryAfter('Retry-After: 2s')).toBe(2_000)
    expect(parseRetryAfter('retry after 1500 ms')).toBe(1_500)
    expect(parseRetryAfter('retry in 5 minutes')).toBe(300_000)
    expect(parseRetryAfter('retry in 2 h')).toBe(7_200_000)
    expect(parseRetryAfter('retryDelay: "30s"')).toBe(30_000)
  })

  it('reads a compact hours/minutes/seconds phrase', () => {
    expect(parseRetryAfter('try again in 1h 2m 3.5s')).toBe(3_723_500)
    expect(parseRetryAfter('try again in 45s')).toBe(45_000)
    expect(parseRetryAfter('try again in 10 minutes')).toBe(600_000)
  })

  it('returns undefined when no delay is stated', () => {
    expect(parseRetryAfter('model overloaded')).toBeUndefined()
    expect(parseRetryAfter('try again in')).toBeUndefined()
  })
})

describe('formatDuration', () => {
  it('rounds up to the unit a reader can act on', () => {
    expect(formatDuration(1_200)).toBe('2s')
    expect(formatDuration(90_000)).toBe('2m')
    expect(formatDuration(5_400_000)).toBe('1.5h')
  })
})
