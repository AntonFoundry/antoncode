import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_SCHEMA, load, Type } from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureBlueantPreset } from '../src/blueant-preset.ts'

let home: string
let preset: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'blueant-preset-'))
  preset = join(home, '.agent-presets', 'blueant')
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
})

function ensure(): void {
  ensureBlueantPreset({ dshHome: home, profile: 'web', harnessRoot: resolve('.') })
}

describe('Blueant tool policy', () => {
  it('offers the harness shell and Chrome actions without proposal polling', () => {
    ensure()
    const config = readFileSync(join(preset, 'agent.cordis.yml'), 'utf8')
    expect(config).toContain("name: '@deepseek-ai/dsh-tool-bash'")
    expect(config).not.toContain('restrict-tools')
    expect(config).not.toContain('blueant_propose')
    const chrome = readFileSync(join(preset, 'plugins', 'chrome.js'), 'utf8')
    expect(chrome).not.toContain('/bridge/api/propose')
    expect(chrome).not.toContain('waitMs')
  })

  it('backs up the old preset and removes restrictions when upgrading to Creator', () => {
    mkdirSync(join(preset, 'plugins'), { recursive: true })
    writeFileSync(join(preset, 'agent.cordis.yml'), [
      '- id: persona', '  name: custom-persona', '  config:', '    text: My custom persona',
      '- id: restrict-tools', '  name: ./plugins/restrict-tools.js', '  config:',
      '    allow: [blueant_propose, blueant_notify, custom_tool]',
      '- id: propose', '  name: ./plugins/propose.js',
      '- id: chrome', '  name: ./plugins/chrome.js', '',
    ].join('\n'))
    writeFileSync(join(preset, 'plugins', 'propose.js'), 'legacy command tool')
    writeFileSync(join(preset, 'plugins', 'chrome.js'), "// required: ['url']\n// /bridge/api/propose/decision")
    ensure()
    const migrated = readFileSync(join(preset, 'agent.cordis.yml'), 'utf8')
    expect(readFileSync(join(preset, 'agent.before-creator.cordis.yml'), 'utf8')).toContain('text: My custom persona')
    expect(migrated).not.toContain('restrict-tools')
    expect(migrated).toContain("name: '@deepseek-ai/dsh-tool-todo'")
    expect(migrated).not.toContain('./plugins/propose.js')
    expect(existsSync(join(preset, 'plugins', 'propose.js'))).toBe(false)
    expect(readFileSync(join(preset, 'plugins', 'chrome.js'), 'utf8')).not.toContain('/bridge/api/propose')
    ensure()
    expect(readFileSync(join(preset, 'agent.cordis.yml'), 'utf8')).toBe(migrated)
  })
})

interface GeneratedTool {
  name: string
  execute: (args: Record<string, string>, exec: { signal: AbortSignal }) => Promise<string>
}

it('returns Chrome action output without requesting or polling a decision', async () => {
  ensure()
  const source = readFileSync(join(preset, 'plugins', 'chrome.js'), 'utf8')
  const registered = new Map<string, GeneratedTool>()
  const apply = new Function(`${source.replaceAll('export ', '')}; return apply`)()
  apply({
    effect: (register: () => void) => register(),
    tools: { register: (tool: GeneratedTool) => registered.set(tool.name, tool) },
  })
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ title: 'Example' }))
    .mockResolvedValueOnce(Response.json({ output: 'OK: clicked submit' }))
  vi.stubGlobal('fetch', fetch)
  await expect(registered.get('chrome_click')!.execute(
    { selector: '#submit' }, { signal: new AbortController().signal },
  )).resolves.toBe('OK: clicked submit')
  expect(fetch.mock.calls.map(call => call[0])).toEqual([
    'http://127.0.0.1:3742/bridge/api/chrome/read',
    'http://127.0.0.1:3742/bridge/api/chrome/act',
  ])
})

const schema = DEFAULT_SCHEMA.extend(new Type('tag:yaml.org,2002:js', { kind: 'scalar' }))

it('retains every Creator plugin and configuration, including isolated groups', () => {
  ensure()
  const creator = readFileSync('apps/cli/config/agent-presets/cordis/agent.cordis.yml', 'utf8')
    .replace('You are a coding agent powered by', "You are Blueant, the user's personal desktop and coding agent, powered by")
    .replace("new URL('skills/', baseUrl)", "new URL('creator-skills/', baseUrl)")
  const expected = load(creator, { schema }) as unknown[]
  const actual = load(readFileSync(join(preset, 'agent.cordis.yml'), 'utf8'), { schema }) as unknown[]
  expect(actual.slice(0, expected.length)).toEqual(expected)
  const ptc = load(readFileSync('apps/cli/config/agent-presets/code/agent.cordis.yml', 'utf8'), { schema }) as Array<{ id: string }>
  expect(actual.slice(expected.length)).toEqual([
    { ...ptc.find(row => row.id === 'tool-presentation'), config: { mode: 'both' } },
    { id: 'blueant-notify', name: './plugins/notify.js' },
    { id: 'blueant-chrome', name: './plugins/chrome.js' },
  ])
  expect(existsSync(join(preset, 'creator-skills', 'editing-cordis-compositions', 'SKILL.md'))).toBe(true)
})

it('refuses to generate a reduced preset when Creator is missing', () => {
  expect(() => ensureBlueantPreset({ dshHome: home, profile: 'web', harnessRoot: home })).toThrow()
  expect(existsSync(join(preset, 'agent.cordis.yml'))).toBe(false)
})
