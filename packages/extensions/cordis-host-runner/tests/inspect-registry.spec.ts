import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { CordisInspectRegistryService } from '../src/inspect-registry.ts'
import type { CordisInspectProviderManifest } from '../src/types.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { HostCordisInspectProviderRegistration } from '../src/inspect-registry.ts'

const AGENT = { id: 'S-a', steer() {}, inject() {} } as unknown as Agent

function manifest(id: string, methods: string[]): CordisInspectProviderManifest {
  return {
    id,
    description: `${id} directory`,
    methods: methods.map(name => ({
      name,
      description: `${name} query`,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    })),
  }
}

function registration(id: string, methods: string[]): HostCordisInspectProviderRegistration {
  return { manifest: manifest(id, methods), query: async method => ({ method }) }
}

async function setup(): Promise<CordisInspectRegistryService> {
  const ctx = new Context()
  const registry = new CordisInspectRegistryService(ctx)
  registry.register({
    manifest: manifest('Service', ['listService']),
    query: async method => ({ method }),
  })
  return registry
}

describe('intent-tolerant inspect query resolution', () => {
  it('accepts a Provider.method qualified name and dispatches the bare method', async () => {
    const registry = await setup()
    const data = await registry.query('host', 'Service', 'Service.listService', undefined, AGENT, new AbortController().signal)
    expect(data).toEqual({ method: 'listService' })
  })

  it('resolves a case-mismatched provider id', async () => {
    const registry = await setup()
    const data = await registry.query('host', 'service', 'listService', undefined, AGENT, new AbortController().signal)
    expect(data).toEqual({ method: 'listService' })
  })

  it('fails an unknown provider with the directory and a cross-platform hit', async () => {
    const registry = await setup()
    registry.syncClientManifest([manifest('Slots', ['listSubTree'])])
    await expect(registry.query('host', 'host', 'listService', undefined, AGENT, new AbortController().signal))
      .rejects.toThrow('registered Host providers: Service')
    await expect(registry.query('host', 'slots', 'listService', undefined, AGENT, new AbortController().signal))
      .rejects.toThrow('provider "Slots" exists on the Client platform')
  })

  it('fails an unknown method with the declared method directory', async () => {
    const registry = await setup()
    await expect(registry.query('host', 'Service', 'list', undefined, AGENT, new AbortController().signal))
      .rejects.toThrow('declared methods: listService')
  })
})

describe('refcounted duplicate registration', () => {
  it('shares one entry for identical manifests and removes it only at the last dispose', async () => {
    const ctx = new Context()
    const registry = new CordisInspectRegistryService(ctx)
    const disposeFirst = registry.register(registration('Service', ['listService']))
    const disposeSecond = registry.register(registration('Service', ['listService']))
    expect(registry.list().filter(provider => provider.id === 'Service')).toHaveLength(1)
    disposeFirst()
    disposeFirst()
    expect(registry.list().some(provider => provider.id === 'Service')).toBe(true)
    const data = await registry.query('host', 'Service', 'Service.listService', undefined, AGENT, new AbortController().signal)
    expect(data).toEqual({ method: 'listService' })
    disposeSecond()
    expect(registry.list().some(provider => provider.id === 'Service')).toBe(false)
  })

  it('serves queries through the newest equal-manifest handler and restores the prior on dispose', async () => {
    const ctx = new Context()
    const registry = new CordisInspectRegistryService(ctx)
    const disposeFirst = registry.register({ manifest: manifest('Service', ['listService']), query: async () => ({ generation: 1 }) })
    const disposeSecond = registry.register({ manifest: manifest('Service', ['listService']), query: async () => ({ generation: 2 }) })
    await expect(registry.query('host', 'Service', 'listService', undefined, AGENT, new AbortController().signal))
      .resolves.toEqual({ generation: 2 })
    disposeSecond()
    await expect(registry.query('host', 'Service', 'listService', undefined, AGENT, new AbortController().signal))
      .resolves.toEqual({ generation: 1 })
    disposeFirst()
    expect(registry.list().some(provider => provider.id === 'Service')).toBe(false)
  })

  it('rejects a conflicting manifest under a live id while keeping the first registration', async () => {
    const registry = await setup()
    expect(() => registry.register(registration('Service', ['listService', 'other']))).toThrow('conflicting manifest')
    expect(() => registry.register({
      manifest: { ...manifest('Service', ['listService']), description: 'different description' },
      query: async method => ({ method }),
    })).toThrow('conflicting manifest')
    const data = await registry.query('host', 'Service', 'listService', undefined, AGENT, new AbortController().signal)
    expect(data).toEqual({ method: 'listService' })
  })

  it('allows re-registration after the last claim is released', async () => {
    const ctx = new Context()
    const registry = new CordisInspectRegistryService(ctx)
    const dispose = registry.register(registration('Service', ['listService']))
    dispose()
    const replacement = registry.register(registration('Service', ['listService']))
    const data = await registry.query('host', 'service', 'listService', undefined, AGENT, new AbortController().signal)
    expect(data).toEqual({ method: 'listService' })
    replacement()
    expect(registry.list().some(provider => provider.id === 'Service')).toBe(false)
  })
})
