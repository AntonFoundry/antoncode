import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

function fixture(config = { reservedProviders: ['openai'], providers: {} }, inherited = {}) {
  const entry = { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config } }
  const registrations = new Map()
  const disposers = []
  let writes = 0
  const ctx = {
    effect(register) { disposers.push(register()) },
    tools: { register(definition) {
      assert.equal(registrations.has(definition.name), false)
      registrations.set(definition.name, definition)
      return () => registrations.delete(definition.name)
    } },
    configEditor: {
      entries: () => [entry],
      async edit(target, change) {
        assert.equal(target, entry)
        const next = change(structuredClone(entry.options.config), inherited)
        entry.options.config = next
        writes++
      },
    },
  }
  apply(ctx)
  return { ctx, entry, registrations, run: args => registrations.get('provider_route_cleanup').execute(args), dispose: () => disposers.splice(0).reverse().forEach(fn => fn()), writes: () => writes }
}

test('activation and inspect are read-only with bounded output', async () => {
  const f = fixture({ reservedProviders: ['openai'], providers: { deepseek: { apiKeyEnv: 'SECRET_REF' } } })
  assert.equal(f.writes(), 0)
  assert.deepEqual(await f.run({ action: 'inspect' }), { action: 'inspect', changed: false, reservedProviders: ['openai'], configuredDuplicates: [], preservedProviderCount: 1 })
  assert.equal(f.writes(), 0)
  f.dispose()
})

test('apply preserves every other field and is idempotent', async () => {
  const config = { reservedProviders: ['openai', 'custom'], providers: { deepseek: { apiKeyEnv: 'SECRET_REF', models: [{ id: 'example' }] } }, modelsDevRefreshMs: 123, future: { retained: true } }
  const f = fixture(config)
  const result = await f.run({ action: 'apply' })
  assert.equal(result.changed, true)
  assert.deepEqual(f.entry.options.config, { ...config, reservedProviders: ['openai', 'custom', 'anthropic', 'openai-codex'] })
  assert.equal((await f.run({ action: 'apply' })).changed, false)
  assert.equal(JSON.stringify(result).includes('SECRET_REF'), false)
  f.dispose()
})

for (const id of ['anthropic', 'openai-codex']) {
  test(`configured ${id} refuses apply without editing`, async () => {
    const f = fixture({ reservedProviders: ['openai'], providers: { [id]: {} } })
    assert.deepEqual((await f.run({ action: 'inspect' })).configuredDuplicates, [id])
    await assert.rejects(f.run({ action: 'apply' }), /Ask the user/)
    assert.equal(f.writes(), 0)
    f.dispose()
  })
}

test('preserves inherited reservations when current array is omitted', async () => {
  const f = fixture({ providers: {} }, { reservedProviders: ['openai', 'custom'] })
  await f.run({ action: 'apply' })
  assert.deepEqual(f.entry.options.config.reservedProviders, ['openai', 'custom', 'anthropic', 'openai-codex'])
  f.dispose()
})

test('invalid action and expression-valued fields fail without edits', async () => {
  for (const config of [{ providers: { __jsExpr: 'opaque' } }, { reservedProviders: { __jsExpr: 'opaque' } }, { reservedProviders: [null] }]) {
    const f = fixture(config)
    await assert.rejects(f.run({ action: 'apply' }), /literal/)
    await assert.rejects(f.run({ action: 'delete' }), /Use exactly/)
    await assert.rejects(f.run({ action: 'apply', route: 'other' }), /Use exactly/)
    assert.equal(f.writes(), 0)
    f.dispose()
  }
})

test('effect disposal unregisters and reactivation registers once', () => {
  const f = fixture()
  assert.equal(f.registrations.size, 1)
  f.dispose()
  assert.equal(f.registrations.size, 0)
  apply(f.ctx)
  assert.equal(f.registrations.size, 1)
  assert.equal(f.writes(), 0)
  f.dispose()
  assert.equal(f.registrations.size, 0)
})
