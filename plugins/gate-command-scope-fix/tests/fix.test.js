import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const original = ['(pnpm\\s+run\\s+)?(deploy|release|publish)\\b', 'npm\\s+publish\\b']
const desired = ['(?:deploy|release|publish)\\b', '(?:npm|pnpm|yarn)\\s+(?:run\\s+)?(?:deploy|release|publish)\\b']
const deploy = () => ({ name: 'deploy-gate', tools: ['bash'], commandPatterns: [...original], checklist: 'Version and clean build.', confirm: true })
const config = () => ({ rules: [{ name: 'delete-gate', tools: ['bash'], commandPatterns: ['rm'], checklist: 'Keep files.' }, deploy()], verdictsTimeoutMs: 4000, verdictsRefreshMs: 300000, verdictsApiKey: 'DO_NOT_RETURN', unknownFuture: { retained: true } })

function fixture(current = config(), supported = true) {
  let writes = 0
  const registration = new Map()
  const disposers = []
  const entry = { options: { id: 'gate-policy', name: '@deepseek-ai/dsh-gate-policy', config: current }, fiber: { resolveConfig(next) {
    return supported ? structuredClone(next) : { ...next, rules: next.rules.map(({ commandScope, ...rule }) => rule) }
  } } }
  const ctx = {
    effect(fn) { disposers.push(fn()) },
    tools: { register(def) { assert.equal(registration.has(def.name), false); registration.set(def.name, def); return () => registration.delete(def.name) } },
    configEditor: { entries: () => [entry], async edit(target, change) { assert.equal(target, entry); entry.options.config = change(structuredClone(entry.options.config), {}); writes++ } },
  }
  apply(ctx)
  return { ctx, entry, registration, writes: () => writes, run: args => registration.get('gate_command_scope_fix').execute(args), dispose: () => disposers.splice(0).forEach(fn => fn()) }
}

test('activation and inspect perform no edit and do not expose secrets/checklists', async () => {
  const f = fixture()
  assert.equal(f.writes(), 0)
  assert.deepEqual(await f.run({ action: 'inspect' }), { action: 'inspect', commandScope: 'raw', commandPatterns: original, preservedRuleCount: 1, changed: false })
  assert.equal(f.writes(), 0)
  f.dispose()
})

test('apply changes exactly two deploy-gate fields and preserves complete config', async () => {
  const before = config()
  const f = fixture(before)
  assert.deepEqual(await f.run({ action: 'apply' }), { action: 'apply', commandScope: 'shellCommands', commandPatterns: desired, preservedRuleCount: 1, changed: true })
  assert.deepEqual(f.entry.options.config, { ...before, rules: [before.rules[0], { ...before.rules[1], commandScope: 'shellCommands', commandPatterns: desired }] })
  assert.equal((await f.run({ action: 'apply' })).changed, false)
  assert.equal(JSON.stringify(await f.run({ action: 'inspect' })).includes('DO_NOT_RETURN'), false)
  f.dispose()
})

test('old runtime that strips unsupported scope refuses before persistence', async () => {
  const f = fixture(config(), false)
  await assert.rejects(f.run({ action: 'apply' }), /does not support shellCommands/)
  assert.equal(f.writes(), 0)
  f.dispose()
})

test('unexpected patterns/tools, duplicate targets and opaque config refuse edits', async () => {
  const variations = [
    { rules: { __jsExpr: 'opaque' } },
    { __jsExpr: 'opaque' },
    { rules: [null] },
    { rules: [deploy(), deploy()] },
    { rules: [{ ...deploy(), commandPatterns: ['arbitrary'] }] },
    { rules: [{ ...deploy(), tools: ['bash', 'write'] }] },
    { rules: [{ ...deploy(), commandScope: { __jsExpr: 'opaque' } }] },
  ]
  for (const current of variations) {
    const f = fixture(current)
    await assert.rejects(f.run({ action: 'apply' }))
    assert.equal(f.writes(), 0)
    f.dispose()
  }
})

test('invalid action and additional fields refuse edits', async () => {
  const f = fixture()
  await assert.rejects(f.run({ action: 'delete' }), /Use exactly/)
  await assert.rejects(f.run({ action: 'apply', config: {} }), /Use exactly/)
  assert.equal(f.writes(), 0)
  f.dispose()
})

test('registration disposes and reactivates exactly once', () => {
  const f = fixture()
  assert.equal(f.registration.size, 1)
  f.dispose()
  assert.equal(f.registration.size, 0)
  apply(f.ctx)
  assert.equal(f.registration.size, 1)
  assert.equal(f.writes(), 0)
  f.dispose()
  assert.equal(f.registration.size, 0)
})
