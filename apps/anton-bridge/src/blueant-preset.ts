import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface EnsureBlueantPresetOptions {
  dshHome: string
  profile: string
  harnessRoot: string
}

/**
 * Blueant's user-trust agent preset: a complete Arivu-style persona (no other
 * prompt sections, no runtime snapshot), a trimmed tool roster, and a scoped
 * c0ntext row tuned for a popup ask-loop (fast retrieval, small budget, scout
 * off). All writes are existsSync-guarded so reruns are no-ops and an existing
 * preset is never clobbered.
 */
export function ensureBlueantPreset({ dshHome }: EnsureBlueantPresetOptions): void {
  const presetDir = join(dshHome, '.agent-presets', 'blueant')
  const ymlPath = join(presetDir, 'agent.cordis.yml')
  const metaPath = join(presetDir, 'preset.yml')
  const restrictPath = join(presetDir, 'plugins', 'restrict-tools.js')
  const notifyPath = join(presetDir, 'plugins', 'notify.js')
  const proposePath = join(presetDir, 'plugins', 'propose.js')
  mkdirSync(presetDir, { recursive: true })
  mkdirSync(dirname(restrictPath), { recursive: true })

  if (!existsSync(proposePath)) {
    writeFileSync(proposePath, [
      '// Act tier: blueant_propose asks before running. Enqueues the command',
      '// for the Mac app approval panel, polls the decision, and returns the',
      '// verdict plus (when approved) the bounded command output. Nothing',
      '// runs unless the user clicks Approve & Run.',
      "export const name = 'blueant-propose'",
      "export const inject = ['tools']",
      '',
      'export function apply(ctx) {',
      '  ctx.effect(() => ctx.tools.register({',
      "    name: 'blueant_propose',",
      "    description: 'Propose a shell command for the user to approve. The user sees the exact command and clicks Approve & Run or Deny. Use for any action beyond reading: opening apps, moving files, sending things, changing settings. Waits for the decision and returns the output.',",
      '    parameters: {',
      "      command: { type: 'string', required: true, description: 'The exact shell command to propose (max 4000 chars)' },",
      "      rationale: { type: 'string', description: 'Optional one-line reason shown to the user' },",
      "      waitMs: { type: 'number', description: 'How long to wait for the decision (default 90000, max 300000)' },",
      '    },',
      "    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },",
      '    async execute(args, exec) {',
      "      const res = await fetch('http://127.0.0.1:3742/bridge/api/propose', {",
      "        method: 'POST',",
      "        headers: { 'content-type': 'application/json' },",
      '        body: JSON.stringify({ command: args.command, rationale: args.rationale }),',
      '        signal: exec.signal,',
      '      })',
      '      if (!res.ok) throw new Error(`blueant_propose failed: HTTP ${res.status}`)',
      '      const { id } = await res.json()',
      '      const deadline = Date.now() + Math.min(Number(args.waitMs) || 90000, 300000)',
      '      while (Date.now() < deadline) {',
      '        if (exec.signal.aborted) throw new Error(`blueant_propose cancelled while awaiting decision (proposal ${id})`)',
      '        await new Promise(resolve => setTimeout(resolve, 2000))',
      '        const check = await fetch(`http://127.0.0.1:3742/bridge/api/propose/decision?id=${encodeURIComponent(id)}`, { signal: exec.signal })',
      '        if (!check.ok) continue',
      '        const verdict = await check.json()',
      "        if (verdict.state === 'pending') continue",
      "        if (verdict.state === 'denied') return 'DENIED: the user declined this command. Do not retry it without asking why.'",
      '        return `APPROVED (exit ${verdict.exitCode})\\n${verdict.output || "(no output)"}`',
      '      }',
      '      return `TIMEOUT: no decision within the wait window (proposal ${id}). The proposal stays on screen; ask the user to decide.`',
      '    },',
      "  }), 'blueant.propose')",
      '}',
      '',
    ].join('\n'))
  }

  if (!existsSync(notifyPath)) {
    writeFileSync(notifyPath, `${[
      '// Act tier v0: blueant_notify posts a macOS notification through the',
      '// bridge inbox (POST /bridge/api/notify); the Mac app polls, delivers it',
      '// via UNUserNotificationCenter, and acks. Loopback only and no Origin',
      '// header, so the browser-CSRF fence does not apply.',
      "export const name = 'blueant-notify'",
      "export const inject = ['tools']",
      '',
      'export function apply(ctx) {',
      '  ctx.effect(() => ctx.tools.register({',
      "    name: 'blueant_notify',",
      "    description: 'Post a macOS notification to the user. Use when a long task finishes or the user asked to be alerted. Keep the body under two sentences.',",
      '    parameters: {',
      "      body: { type: 'string', required: true, description: 'Notification text (max ~2000 chars)' },",
      "      title: { type: 'string', description: 'Short title; defaults to Blueant' },",
      '    },',
      "    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },",
      '    async execute(args, exec) {',
      "      const res = await fetch('http://127.0.0.1:3742/bridge/api/notify', {",
      "        method: 'POST',",
      "        headers: { 'content-type': 'application/json' },",
      '        body: JSON.stringify({ title: args.title, body: args.body }),',
      '        signal: exec.signal,',
      '      })',
      '      if (!res.ok) throw new Error(`blueant_notify failed: HTTP ${res.status}`)',
      "      return 'notification queued'",
      '    },',
      '  }), \'blueant.notify\')',
      '}',
      '',
    ].join('\n')}`)
  }

  if (!existsSync(restrictPath)) {
    writeFileSync(restrictPath, `${[
      '// Blueant tool roster: memory/search tools only. No bash, no file edits,',
      '// no Anton lifecycle. Names outside the roster become invisible to the',
      '// agent for this preset scope; restrictions intersect with deployment.',
      "export const name = 'blueant-restrict-tools'",
      "export const inject = ['tools']",
      '',
      'export function apply(ctx, config) {',
      '  const known = config.allow.filter(name => ctx.tools.get(name) !== undefined)',
      '  if (known.length === 0) return',
      "  ctx.effect(() => ctx.tools.restrict({ allow: known }), 'blueant.restrict')",
      '}',
      '',
    ].join('\n')}`)
  }
  if (!existsSync(ymlPath)) {
    writeFileSync(ymlPath, `${[
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    text: >-',
      "      You are Blueant, the user's personal desktop agent. You are direct,",
      '      context-aware, and terse. You answer from what you actually read and',
      '      say so — cite the memory entry, recipe, or search result you used.',
      '      You are not a coding assistant: you answer questions and handle small',
      "      tasks about the user's day and machine. Default to one short",
      '      paragraph; ask at most one clarifying question only when the ask is',
      '      genuinely ambiguous.',
      '    complete: true',
      '    includeRuntimeContext: false',
      '- id: restrict-tools',
      '  name: ./plugins/restrict-tools.js',
      '  config:',
      '    allow: [c0ntext_search, c0ntext_remember, recipe_search, web_search, read_image, blueant_notify, blueant_propose]',
      '- id: notify',
      '  name: ./plugins/notify.js',
      '- id: propose',
      '  name: ./plugins/propose.js',
      // NOTE: no c0ntext row here. The plugin registers its toolMatcher service
      // at mount, so a preset-scope second mount fails loud ("service
      // toolMatcher has been registered"); retrieval tuning (retrieveMode,
      // tokenBudget) therefore stays a deployment-layer choice. Scout is
      // already disabled by the plugin's default config.
      '',
    ].join('\n')}`)
  }
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, `${[
      'name: Blueant',
      'description: Personal desktop ask-loop agent for the Anton popup — direct, context-aware, terse.',
      '',
    ].join('\n')}`)
  }
}

/**
 * Junction-symlink the persona package into the profile's node_modules so the
 * preset row's `@deepseek-ai/dsh-persona` name resolves from the host
 * composition — the same mechanism the bridge uses for @c0ntext/dsh-c0ntext.
 */
export function ensureBlueantProfileLink({ dshHome, profile, harnessRoot }: EnsureBlueantPresetOptions): void {
  const personaRoot = resolve(harnessRoot, 'packages', 'preset', 'persona')
  if (!existsSync(personaRoot)) {
    throw new Error(`Bundled persona package was not found at ${personaRoot}`)
  }
  const link = join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh-persona')
  mkdirSync(dirname(link), { recursive: true })
  try {
    if (lstatSync(link).isSymbolicLink()) {
      unlinkSync(link)
    } else {
      throw new Error(`Profile path ${link} exists and is not a symlink`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  symlinkSync(personaRoot, link, 'junction')
}
