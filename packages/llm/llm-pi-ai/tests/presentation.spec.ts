import { describe, expect, it } from 'vitest'
import { displayModelName, displayProviderName } from '../src/presentation.ts'

describe('model selector names', () => {
  it('brands built-in provider ids while preserving configured labels', () => {
    expect(displayProviderName('nvidia', 'nvidia')).toBe('NVIDIA')
    expect(displayProviderName('anthropic', 'anthropic')).toBe('Anthropic Claude')
    expect(displayProviderName('zai', 'zai')).toBe('Z.ai')
    expect(displayProviderName('acme-gateway', 'acme-gateway')).toBe('Acme Gateway')
    expect(displayProviderName('acme-gateway', 'Acme Proxy')).toBe('Acme Proxy')
  })

  it('formats ids and names without changing the provider-facing model id', () => {
    expect(displayModelName('z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flash')).toBe('GLM 5.3 Flash')
    expect(displayModelName('Llama-3.2-90B-Vision-Instruct', 'meta/llama-3.2-90b-vision-instruct'))
      .toBe('Llama 3.2 90B Vision Instruct')
    expect(displayModelName('nvidia/nemotron-3-nano-30b-a3b', 'nvidia/nemotron-3-nano-30b-a3b'))
      .toBe('Nemotron 3 Nano 30B A3B')
    expect(displayModelName('Acme   Reasoner', 'acme-reasoner')).toBe('Acme Reasoner')
    expect(displayModelName('', '')).toBe('')
  })
})
