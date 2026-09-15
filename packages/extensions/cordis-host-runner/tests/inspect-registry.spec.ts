import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { CordisInspectRegistryService } from '../src/inspect-registry.ts'
import type { CordisInspectProviderManifest } from '../src/types.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

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
