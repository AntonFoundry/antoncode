import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface EnsureBlueantPresetOptions {
  dshHome: string
  profile: string
  harnessRoot: string
}

/**
 * Generate Blueant from Creator, PTC presentation, and desktop tools.
 * The bridge owns this file; its first replacement preserves the old preset.
 * @param options - Harness installation and user preset locations.
 */
export function ensureBlueantPreset({ dshHome, harnessRoot }: EnsureBlueantPresetOptions): void {
  const presetDir = join(dshHome, '.agent-presets', 'blueant')
  const ymlPath = join(presetDir, 'agent.cordis.yml')
  const metaPath = join(presetDir, 'preset.yml')
  const chromePath = join(presetDir, 'plugins', 'chrome.js')
  const creatorDir = join(harnessRoot, 'apps', 'cli', 'config', 'agent-presets', 'cordis')
  const creator = readFileSync(join(creatorDir, 'agent.cordis.yml'), 'utf8')
  const code = readFileSync(join(creatorDir, '..', 'code', 'agent.cordis.yml'), 'utf8')
  const presentationStart = code.indexOf('- id: tool-presentation\n')
  if (presentationStart === -1) throw new Error('PTC preset is missing tool-presentation')
  const presentationEnd = code.indexOf('\n- id: ', presentationStart + 1)
  const presentation = code.slice(presentationStart, presentationEnd === -1 ? undefined : presentationEnd).trimEnd().replace('mode: code', 'mode: both')

  mkdirSync(dirname(chromePath), { recursive: true })
  cpSync(join(creatorDir, 'skills'), join(presetDir, 'creator-skills'), { recursive: true })

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

  const notifyPath = join(presetDir, 'plugins', 'notify.js')
  writeFileSync(notifyPath, [
    "export const name = 'blueant-notify'",
    "export const inject = ['tools']",
    'export function apply(ctx) {',
    '  ctx.effect(() => ctx.tools.register({',
    "    name: 'blueant_notify',",
    "    description: 'Post a desktop notification with a title and body.',",
    "    parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['body'] },",
    "    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },",
    '    async execute(args, exec) {',
    "      const response = await fetch('http://127.0.0.1:3742/bridge/api/notify', {",
    "        method: 'POST', headers: { 'content-type': 'application/json' },",
    '        body: JSON.stringify(args), signal: exec.signal,',
    '      })',
    '      if (!response.ok) throw new Error(`Notification failed: HTTP ${response.status}`)',
    "      return 'Notification queued.'",
    '    },',
    "  }), 'blueant.notify')",
    '}',
    '',
  ].join('\n'))

  const marker = '# Managed Blueant preset: Creator capabilities, PTC mode, and desktop tools.'
  const ymlContent = `${marker}\n${creator
    .replace('You are a coding agent powered by', "You are Blueant, the user's personal desktop and coding agent, powered by")
    .replace("new URL('skills/', baseUrl)", "new URL('creator-skills/', baseUrl)")
    .trimEnd()}\n\n${presentation}\n\n- id: blueant-notify\n  name: ./plugins/notify.js\n\n- id: blueant-chrome\n  name: ./plugins/chrome.js\n`
  const existing = existsSync(ymlPath) ? readFileSync(ymlPath, 'utf8') : undefined
  if (existing !== undefined && !existing.startsWith(marker)) {
    const backup = join(presetDir, 'agent.before-creator.cordis.yml')
    if (!existsSync(backup)) writeFileSync(backup, existing)
  }
  if (existing !== ymlContent) writeFileSync(ymlPath, ymlContent)
  for (const obsolete of ['restrict-tools.js', 'propose.js']) {
    const path = join(presetDir, 'plugins', obsolete)
    if (existsSync(path)) unlinkSync(path)
  }
  writeFileSync(metaPath, [
    'name: Blueant',
    'description: Creator capabilities with PTC code execution, desktop Chrome actions, and notifications.',
    '',
  ].join('\n'))
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
