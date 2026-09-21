import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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
  const chromePath = join(presetDir, 'plugins', 'chrome.js')
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

  if (!existsSync(chromePath)) {
    writeFileSync(chromePath, [
      '// Chrome acting-as-user: read-tier tools are ungated Ask tier (the',
      '// agent profile is isolated from the user\'s daily browser); fill and',
      '// click enqueue proposal cards and wait for the human decision, then',
      '// report what actually happened on the page.',
      "export const name = 'blueant-chrome'",
      "export const inject = ['tools']",
      '',
      'export function apply(ctx) {',
      '  const bridge = \'http://127.0.0.1:3742\'',
      "  const decide = (verdict) => verdict.state === 'pending' ? null",
      "    : verdict.state === 'denied' ? `DENIED: the user declined this page action (${verdict.command}). Do not retry it without asking why.`",
      "    : String(verdict.output || 'APPROVED but the page gave no result')",
      '  async function proposeAct(path, body, waitMs, exec) {',
      '    const titleRes = await fetch(`${bridge}/bridge/api/chrome/read`, { signal: exec.signal }).catch(() => null)',
      "    const pageTitle = titleRes && titleRes.ok ? (await titleRes.json()).title || 'current page' : 'current page'",
      '    const res = await fetch(`${bridge}${path}`, {',
      "      method: 'POST',",
      "      headers: { 'content-type': 'application/json' },",
      '      body: JSON.stringify({ ...body, pageTitle }),',
      '      signal: exec.signal,',
      '    })',
      '    if (!res.ok) throw new Error(`chrome ${body.action} failed: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)',
      '    const { id } = await res.json()',
      '    const deadline = Date.now() + Math.min(Number(waitMs) || 90000, 300000)',
      '    while (Date.now() < deadline) {',
      '      if (exec.signal.aborted) throw new Error(`cancelled while awaiting decision (${id})`)',
      '      await new Promise(resolve => setTimeout(resolve, 2000))',
      '      const check = await fetch(`${bridge}/bridge/api/propose/decision?id=${encodeURIComponent(id)}`, { signal: exec.signal })',
      '      if (!check.ok) continue',
      '      const verdict = await decide(await check.json())',
      '      if (verdict !== null) return verdict',
      '    }',
      '    return `TIMEOUT: no decision within the wait window (${id}). The card stays on screen; ask the user to decide.`',
      '  }',
      '  ctx.effect(() => ctx.tools.register({',
      "    name: 'chrome_open',",
      "    description: 'Open a URL in the Blueant agent Chrome window (an isolated profile the user can see and grab). Read-only; the window appears on screen. Use before chrome_read to reach a page.',",
      '    parameters: {',
      "      url: { type: 'string', required: true, description: 'http(s) URL to open' },",
      "      reuse: { type: 'boolean', description: 'Reuse the current tab instead of opening a new one' },",
      '    },',
      "    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },",
      '    async execute(args, exec) {',
      '      const res = await fetch(`${bridge}/bridge/api/chrome/open`, {',
      "        method: 'POST',",
      "        headers: { 'content-type': 'application/json' },",
      '        body: JSON.stringify({ url: args.url, reuse: args.reuse === true }),',
      '        signal: exec.signal,',
      '      })',
      '      if (!res.ok) throw new Error(`chrome_open failed: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)',
      '      const { title } = await res.json()',
      "      return `opened in the agent Chrome${title ? `: ${title}` : ''}`",
      '    },',
      "  }), 'blueant.chrome.open')",
      '  ctx.effect(() => ctx.tools.register({',
      "    name: 'chrome_read',",
      "    description: 'Read the active tab of the Blueant agent Chrome: page text, URL, and a form outline (fields, labels, buttons). Use it to see what a page offers before proposing any fill or click.',",
      '    parameters: {}',
      ',',
      "    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },",
      '    async execute(_args, exec) {',
      '      const res = await fetch(`${bridge}/bridge/api/chrome/read`, { signal: exec.signal })',
      '      if (!res.ok) throw new Error(`chrome_read failed: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)',
      '      const page = await res.json()',
      '      const forms = (page.forms || []).map(f => {',
      "        const bits = [f.tag + (f.type ? `[type=${f.type}]` : ''), f.id ? `#${f.id}` : '', f.name ? `[name=${f.name}]` : '', f.label ? `label '${f.label}'` : (f.placeholder ? `placeholder '${f.placeholder}'` : ''), f.value ? `value '${f.value}'` : '']",
      "        if (f.options) bits.push(`options: ${f.options.join(' | ')}`)",
      "        const selector = f.id ? `#${f.id}` : (f.name ? `[name=${f.name}]` : f.tag + (f.type ? `[type=${f.type}]` : ''))",
      "        return `- ${bits.filter(Boolean).join(' ')} (selector: ${selector})`",
      '      }).join(\'\\n\')',
      "      const buttons = (page.buttons || []).filter(Boolean).map(b => `- '${b}'`).join('\\n')",
      "      return `PAGE: ${page.title} (${page.url})\n\nTEXT:\n${page.text}\n\nFORM FIELDS:\n${forms || '(none)'}\n\nBUTTONS:\n${buttons || '(none)'}`",
      '    },',
      "  }), 'blueant.chrome.read')",
      '  ctx.effect(() => ctx.tools.register({',
      "    name: 'chrome_fill',",
      "    description: 'Fill one form field in the Blueant agent Chrome. The user sees a card (field, value, page) and must approve. Selectors come from the chrome_read form outline. One field per call — batch approval does not exist.',",
      '    parameters: {',
      "      selector: { type: 'string', required: true, description: 'CSS selector of the field, from chrome_read (e.g. #email or input[name=q])' },",
      "      value: { type: 'string', required: true, description: 'Text to type into the field (max 2000 chars)' },",
      "      waitMs: { type: 'number', description: 'How long to wait for approval (default 90000, max 300000)' },",
      '    },',
      "    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },",
      "    async execute(args, exec) { return proposeAct('/bridge/api/chrome/act', { action: 'fill', selector: args.selector, value: args.value }, args.waitMs, exec) },",
      "  }), 'blueant.chrome.fill')",
      '  ctx.effect(() => ctx.tools.register({',
      "    name: 'chrome_click',",
      "    description: 'Click one element in the Blueant agent Chrome (buttons, links, submit). The user sees a card and must approve. Prefer chrome_fill + one final click of the submit button.',",
      '    parameters: {',
      "      selector: { type: 'string', required: true, description: 'CSS selector of the element to click' },",
      "      waitMs: { type: 'number', description: 'How long to wait for approval (default 90000, max 300000)' },",
      '    },',
      "    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },",
      "    async execute(args, exec) { return proposeAct('/bridge/api/chrome/act', { action: 'click', selector: args.selector }, args.waitMs, exec) },",
      "  }), 'blueant.chrome.click')",
      '}',
      '',
    ].join('\n'))
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
  const ymlContent = `${[
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
    '    allow: [c0ntext_search, c0ntext_remember, recipe_search, web_search, read_image, blueant_notify, blueant_propose, chrome_open, chrome_read, chrome_fill, chrome_click, skill]',
    // Skills as files: the deployment disables host-level skill rows, so the
    // preset owns local discovery (skill-filesystem registers into this
    // preset's layer) and mounts the catalog/loader tool. A Blueant skill is
    // a file under <dshHome>/skills/<name>/SKILL.md — instructions plus tool
    // usage, no code.
    '- id: skill-filesystem',
    "  name: '@deepseek-ai/dsh-skill-filesystem'",
    '- id: tool-skill',
    "  name: '@deepseek-ai/dsh-tool-skill'",
    '- id: notify',
    '  name: ./plugins/notify.js',
    '- id: propose',
    '  name: ./plugins/propose.js',
    // Chrome acting-as-user: read tier ungated (isolated agent profile),
    // fill/click are approve-gated page mutations.
    '- id: chrome',
    '  name: ./plugins/chrome.js',
    // NOTE: no c0ntext row here. The plugin registers its toolMatcher service
    // at mount, so a preset-scope second mount fails loud ("service
    // toolMatcher has been registered"); retrieval tuning (retrieveMode,
    // tokenBudget) therefore stays a deployment-layer choice. Scout is
    // already disabled by the plugin's default config.
    '',
  ].join('\n')}`
  if (!existsSync(ymlPath) || !readFileSync(ymlPath, 'utf8').includes('./plugins/chrome.js')) {
    writeFileSync(ymlPath, ymlContent)
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
  const linkRoot = join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai')
  mkdirSync(linkRoot, { recursive: true })
  // Persona plus the preset-owned skill packages: preset rows resolve bare
  // package names from the profile's node_modules.
  for (const [name, relative] of [
    ['dsh-persona', join('packages', 'preset', 'persona')],
    ['dsh-skill-filesystem', join('packages', 'skill', 'skill-filesystem')],
    ['dsh-tool-skill', join('packages', 'skill', 'tool-skill')],
  ] as const) {
    const packageRoot = resolve(harnessRoot, relative)
    if (!existsSync(packageRoot)) {
      throw new Error(`Bundled package was not found at ${packageRoot}`)
    }
    const link = join(linkRoot, name)
    try {
      if (lstatSync(link).isSymbolicLink()) {
        unlinkSync(link)
      } else if (existsSync(link)) {
        throw new Error(`Profile path ${link} exists and is not a symlink`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    symlinkSync(packageRoot, link, 'junction')
  }
}
