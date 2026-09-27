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
 * off). Existing persona and tool settings are preserved when retiring the
 * bridge command tool; Chrome plugins using approval polling are replaced.
 */
export function ensureBlueantPreset({ dshHome }: EnsureBlueantPresetOptions): void {
  const presetDir = join(dshHome, '.agent-presets', 'blueant')
  const ymlPath = join(presetDir, 'agent.cordis.yml')
  const metaPath = join(presetDir, 'preset.yml')
  const restrictPath = join(presetDir, 'plugins', 'restrict-tools.js')
  const chromePath = join(presetDir, 'plugins', 'chrome.js')
  mkdirSync(presetDir, { recursive: true })
  mkdirSync(dirname(restrictPath), { recursive: true })

  if (!existsSync(chromePath) || !readFileSync(chromePath, 'utf8').includes("required: ['url']")
    || readFileSync(chromePath, 'utf8').includes('/bridge/api/propose')) {
    writeFileSync(chromePath, [
      '// Chrome actions use the harness tool policy and return page results.',
      "export const name = 'blueant-chrome'",
      "export const inject = ['tools']",
      '',
      'export function apply(ctx) {',
      '  const bridge = \'http://127.0.0.1:3742\'',
      '  async function performAct(body, exec) {',
      '    const titleRes = await fetch(`${bridge}/bridge/api/chrome/read`, { signal: exec.signal }).catch(() => null)',
      "    const pageTitle = titleRes && titleRes.ok ? (await titleRes.json()).title || 'current page' : 'current page'",
      '    const res = await fetch(`${bridge}/bridge/api/chrome/act`, {',
      "      method: 'POST',",
      "      headers: { 'content-type': 'application/json' },",
      '      body: JSON.stringify({ ...body, pageTitle }),',
      '      signal: exec.signal,',
      '    })',
      '    if (!res.ok) throw new Error(`chrome ${body.action} failed: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)',
      '    const { output } = await res.json()',
      '    return output',
      '  }',
      '  ctx.effect(() => ctx.tools.register({',
      "    name: 'chrome_open',",
      "    description: 'Open a URL in the Blueant agent Chrome window (an isolated profile the user can see and grab). Read-only; the window appears on screen. Use before chrome_read to reach a page.',",
      '    parameters: {',
      "      type: 'object',",
      '      properties: {',
      "        url: { type: 'string', description: 'http(s) URL to open' },",
      "        reuse: { type: 'boolean', description: 'Reuse the current tab instead of opening a new one' },",
      '      },',
      "      required: ['url'],",
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
      "    description: 'Read the active tab of the Blueant agent Chrome: page text, URL, and a form outline (fields, labels, buttons). Use it to see what a page offers before filling or clicking.',",
      "    parameters: { type: 'object', properties: {} },",
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
      "    description: 'Fill one form field in the Blueant agent Chrome. Selectors come from the chrome_read form outline. One field per call.',",
      '    parameters: {',
      "      type: 'object',",
      '      properties: {',
      "        selector: { type: 'string', description: 'CSS selector of the field, from chrome_read (e.g. #email or input[name=q])' },",
      "        value: { type: 'string', description: 'Text to type into the field (max 2000 chars)' },",
      '      },',
      "      required: ['selector', 'value'],",
      '    },',
      "    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },",
      "    async execute(args, exec) { return performAct({ action: 'fill', selector: args.selector, value: args.value }, exec) },",
      "  }), 'blueant.chrome.fill')",
      '  ctx.effect(() => ctx.tools.register({',
      "    name: 'chrome_click',",
      "    description: 'Click one element in the Blueant agent Chrome (buttons, links, submit). Prefer chrome_fill + one final click of the submit button.',",
      '    parameters: {',
      "      type: 'object',",
      '      properties: {',
      "        selector: { type: 'string', description: 'CSS selector of the element to click' },",
      '      },',
      "      required: ['selector'],",
      '    },',
      "    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },",
      "    async execute(args, exec) { return performAct({ action: 'click', selector: args.selector }, exec) },",
      "  }), 'blueant.chrome.click')",
      '}',
      '',
    ].join('\n'))
  }

  if (!existsSync(restrictPath)) {
    writeFileSync(restrictPath, `${[
      '// Preset tool visibility intersects with deployment restrictions.',
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
    '    allow: [bash, c0ntext_search, c0ntext_remember, recipe_search, web_search, read_image, chrome_open, chrome_read, chrome_fill, chrome_click, skill]',
    // Skills as files: the deployment disables host-level skill rows, so the
    // preset owns local discovery (skill-filesystem registers into this
    // preset's layer) and mounts the catalog/loader tool. A Blueant skill is
    // a file under <dshHome>/skills/<name>/SKILL.md — instructions plus tool
    // usage, no code.
    '- id: skill-filesystem',
    "  name: '@deepseek-ai/dsh-skill-filesystem'",
    '- id: tool-skill',
    "  name: '@deepseek-ai/dsh-tool-skill'",
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
  const existingPreset = readFileSync(ymlPath, 'utf8')
  const migratedPreset = existingPreset
    .replace(/^- id: propose\r?\n  name: \.\/plugins\/propose\.js\r?\n/gm, '')
    .replace(/^(\s*allow:.*)\bblueant_propose\b/gm, '$1bash')
  if (migratedPreset !== existingPreset) writeFileSync(ymlPath, migratedPreset)
  const proposePath = join(presetDir, 'plugins', 'propose.js')
  if (existsSync(proposePath)) unlinkSync(proposePath)
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
