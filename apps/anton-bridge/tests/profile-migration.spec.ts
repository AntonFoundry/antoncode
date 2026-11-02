import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeObsoleteToolsRow, upsertDesktopToolsRow } from '../src/profile-migration.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function patch(text: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'anton-profile-migration-'))
  directories.push(directory)
  const path = join(directory, 'cordis.patch.yml')
  writeFileSync(path, text)
  return path
}

describe('removeObsoleteToolsRow', () => {
  it('removes a tools row that sets mode, with its comment block, and keeps the original', () => {
    const original = [
      '- id: directory-picker',
      '  config:',
      '    kind: browse',
      '',
      '# The deployment default presentation.',
      '- id: tools',
      '  config:',
      '    mode: paged',
      '    # spine',
      '    pinned:',
      '      - read',
      '',
      '# Memory row.',
      '- id: c0ntext-context',
      '  disabled: false',
      '',
    ].join('\n')
    const path = patch(original)
    removeObsoleteToolsRow(path)
    expect(readFileSync(path, 'utf8')).toBe([
      '- id: directory-picker',
      '  config:',
      '    kind: browse',
      '',
      '# Memory row.',
      '- id: c0ntext-context',
      '  disabled: false',
      '',
    ].join('\n'))
    expect(readFileSync(`${path}.pre-0.2`, 'utf8')).toBe(original)
  })

  it('leaves an empty list when the tools row was the whole patch', () => {
    const path = patch('- id: tools\n  config:\n    mode: paged\n')
    removeObsoleteToolsRow(path)
    expect(readFileSync(path, 'utf8')).toBe('[]\n')
  })

  it('leaves a tools row without mode and a patch without a tools row untouched', () => {
    const configured = '- id: tools\n  disabled: false\n'
    const path = patch(configured)
    removeObsoleteToolsRow(path)
    expect(readFileSync(path, 'utf8')).toBe(configured)
    const other = patch('- id: web\n  config:\n    port: 1\n')
    removeObsoleteToolsRow(other)
    expect(readFileSync(other, 'utf8')).toBe('- id: web\n  config:\n    port: 1\n')
  })
})

describe('upsertDesktopToolsRow', () => {
  it('keeps profile settings and preset declarations that follow the managed row', () => {
    const original = [
      '- id: web',
      '# anton-desktop-tools: managed',
      '- insert:',
      '    - id: anton-desktop-tools',
      '      name: ./plugins/old-desktop-tools.js',
      '- id: llm-pi-ai',
      '  config:',
      '    providers: {}',
      '- insert:',
      '    - id: preset-blueant',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '',
    ].join('\n')
    const next = upsertDesktopToolsRow(original)
    expect(next).toContain('- id: llm-pi-ai\n  config:\n    providers: {}')
    expect(next).toContain('- id: preset-blueant')
    expect(next).toContain('name: ./plugins/anton-desktop-tools.js')
    expect(next).not.toContain('old-desktop-tools.js')
    expect(upsertDesktopToolsRow(next)).toBe(next)
  })
})
