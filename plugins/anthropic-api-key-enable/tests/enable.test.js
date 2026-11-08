import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const keyed = { displayName: 'Anthropic (API key)', apiKeyEnv: 'ANTHROPIC_API_KEY' }
function fixture(config = { reservedProviders: ['openai', 'anthropic', 'openai-codex'], providers: {} }, inherited = {}) {
  const entry = { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config } }
  const tools = new Map(), commands = new Map(), disposers = []
  let writes = 0, failure
  const register = map => definition => { assert.equal(map.has(definition.name), false); map.set(definition.name, definition); return () => map.delete(definition.name) }
  const ctx = {
    effect(registerEffect) { disposers.push(registerEffect()) },
    tools: { register: register(tools) }, commands: { register: register(commands) },
    configEditor: {
      entries: () => [entry],
      configuration: () => [{ entry, inherited }],
      async edit(target, change) { assert.equal(target, entry); const next = change(structuredClone(entry.options.config), inherited); if (failure) throw failure; entry.options.config = next; writes++ },
    },
  }
  apply(ctx)
  return { ctx, entry, tools, commands, writes: () => writes, fail: error => { failure = error }, run: args => tools.get('anthropic_api_key_enable').execute(args), command: rawInput => commands.get('anthropic-api-key-enable').handler({ rawInput }), dispose: () => disposers.splice(0).reverse().forEach(fn => fn()) }
}

test('activation and both inspect surfaces make no edits and expose bounded metadata', async () => {
  const f = fixture({ providers: { other: { apiKeyEnv: 'DO_NOT_RETURN', future: { token: 'SYNTHETIC_SECRET' } } } })
  assert.equal(f.writes(), 0)
  assert.equal(f.commands.get('anthropic-api-key-enable').recordInput, false)
  const result = await f.run({ action: 'inspect' })
  assert.equal(result.anthropicConfigured, false)
  assert.equal(result.providerCount, 1)
  assert.equal(JSON.stringify(result).includes('DO_NOT_RETURN'), false)
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'), false)
  assert.deepEqual(JSON.parse((await f.command('')).text), result)
  assert.equal(f.writes(), 0)
  f.dispose()
})

test('apply changes only the reservation and absent fixed profile, preserving all other configuration', async () => {
  const config = { reservedProviders: ['openai', 'anthropic', 'custom', 'openai-codex', 'anthropic'], providers: { other: { apiKeyEnv: 'DO_NOT_RETURN', models: [{ id: 'synthetic-model' }], future: { nested: true } } }, modelsDevRefreshMs: 12, future: { retained: true } }
  const f = fixture(config)
  const result = await f.run({ action: 'apply' })
  assert.deepEqual(f.entry.options.config, { ...config, reservedProviders: ['openai', 'custom', 'openai-codex'], providers: { ...config.providers, anthropic: keyed } })
  assert.equal(result.changed, true)
  assert.equal(result.anthropicReserved, false)
  assert.equal(result.explicitApiKeyConfigured, true)
  assert.equal(JSON.stringify(result).includes('DO_NOT_RETURN'), false)
  assert.equal((await f.run({ action: 'apply' })).changed, false)
  f.dispose()
})

test('existing explicitly keyed Anthropic options are preserved, including custom endpoint and model options', async () => {
  const anthropic = { ...keyed, displayName: 'anthropic', api: 'anthropic-messages', baseURL: 'http://127.0.0.1:1', models: [{ id: 'synthetic-model' }], headers: { 'x-custom': 'DO_NOT_RETURN' }, future: { retained: true } }
  const f = fixture({ providers: { anthropic }, reservedProviders: ['anthropic', 'openai'] })
  const result = await f.command('apply')
  assert.equal(result.kind, 'success')
  assert.deepEqual(f.entry.options.config.providers.anthropic, { ...anthropic, displayName: keyed.displayName })
  assert.equal(JSON.stringify(result).includes('DO_NOT_RETURN'), false)
  f.dispose()
})

test('omitted targeted fields preserve inherited providers and reservations', async () => {
  const inherited = { reservedProviders: ['openai', 'anthropic', 'openai-codex'], providers: { other: { apiKeyEnv: 'DO_NOT_RETURN' } } }
  const f = fixture({ future: 123 }, inherited)
  assert.equal((await f.run({ action: 'inspect' })).anthropicReserved, true)
  await f.run({ action: 'apply' })
  assert.deepEqual(f.entry.options.config, { future: 123, reservedProviders: ['openai', 'openai-codex'], providers: { ...inherited.providers, anthropic: keyed } })
  f.dispose()
})

for (const [label, config] of [
  ['opaque providers', { providers: { __jsExpr: 'opaque' } }],
  ['opaque reservations', { reservedProviders: { __jsExpr: 'opaque' } }],
  ['invalid reservation', { reservedProviders: [null] }],
  ['null map', { providers: null }],
  ['opaque profile', { providers: { anthropic: { __jsExpr: 'opaque' } } }],
  ['different key', { providers: { anthropic: { apiKeyEnv: 'OTHER_KEY' } } }],
  ['ambiguous missing key', { providers: { anthropic: {} } }],
  ['OAuth field', { providers: { anthropic: { ...keyed, oauth: {} } } }],
  ['authentication header', { providers: { anthropic: { ...keyed, headers: { Authorization: 'SYNTHETIC_SECRET' } } } }],
  ['different protocol', { providers: { anthropic: { ...keyed, api: 'openai-completions' } } }],
]) {
  test(`${label} refuses without edits`, async () => {
    const f = fixture(config)
    await assert.rejects(f.run({ action: 'apply' }))
    assert.equal(f.writes(), 0)
    f.dispose()
  })
}

test('strict action parsing refuses extra fields and command arguments without edits', async () => {
  const f = fixture()
  for (const args of [null, { action: 'delete' }, { action: 'apply', apiKey: 'SYNTHETIC_SECRET' }]) await assert.rejects(f.run(args), /Use exactly/)
  assert.equal((await f.command('apply SYNTHETIC_SECRET')).kind, 'error')
  assert.equal(f.writes(), 0)
  f.dispose()
})

test('target replacement, missing target and duplicate targets refuse edits', async () => {
  for (const entries of [[], [{ options: { id: 'llm-pi-ai', name: 'other' } }]]) {
    const f = fixture(); f.ctx.configEditor.entries = () => entries
    await assert.rejects(f.run({ action: 'apply' }), /one addressable/)
    assert.equal(f.writes(), 0); f.dispose()
  }
  const f = fixture(); f.ctx.configEditor.entries = () => [f.entry, f.entry]
  await assert.rejects(f.run({ action: 'apply' }), /one addressable/)
  f.ctx.configEditor.entries = () => [f.entry]; f.ctx.configEditor.configuration = () => []
  await assert.rejects(f.run({ action: 'inspect' }), /changed/)
  assert.equal(f.writes(), 0); f.dispose()
})

test('ConfigEditor failures propagate without claiming success', async () => {
  const f = fixture(); const before = structuredClone(f.entry.options.config)
  const failure = new Error('Synthetic reconciliation failure'); f.fail(failure)
  await assert.rejects(f.run({ action: 'apply' }), error => error === failure)
  assert.deepEqual(f.entry.options.config, before)
  assert.equal(f.writes(), 0); f.dispose()
})

test('both registrations dispose and reactivate without writes', () => {
  const f = fixture()
  assert.equal(f.tools.size, 1); assert.equal(f.commands.size, 1)
  f.dispose(); assert.equal(f.tools.size, 0); assert.equal(f.commands.size, 0)
  apply(f.ctx); assert.equal(f.tools.size, 1); assert.equal(f.commands.size, 1)
  assert.equal(f.writes(), 0); f.dispose()
})
