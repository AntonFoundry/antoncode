import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  ensureBlueantPreset({ dshHome: home, profile: 'web', harnessRoot: home })
}

describe('Blueant tool policy', () => {
  it('offers the harness shell and Chrome actions without proposal polling', () => {
    ensure()
    const config = readFileSync(join(preset, 'agent.cordis.yml'), 'utf8')
    expect(config).toContain('allow: [bash,')
    expect(config).not.toContain('blueant_propose')
    const chrome = readFileSync(join(preset, 'plugins', 'chrome.js'), 'utf8')
    expect(chrome).not.toContain('/bridge/api/propose')
    expect(chrome).not.toContain('waitMs')
  })

  it('retires installed proposal plugins while preserving customized persona and unrelated tools', () => {
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
    expect(migrated).toContain('text: My custom persona')
    expect(migrated).toContain('allow: [bash, blueant_notify, custom_tool]')
    expect(migrated).not.toContain('propose')
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
