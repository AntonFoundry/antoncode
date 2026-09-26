import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ journalEnabled: vi.fn(() => true) }))

vi.mock('../src/blueant-settings.ts', () => ({ journalEnabled: mocks.journalEnabled }))

import { appendVoiceTurn, recentVoiceContext, startJournalCollector } from '../src/journal.ts'

const directories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  mocks.journalEnabled.mockImplementation(() => true)
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true })
})

describe('Blueant voice journal', () => {
  it('persists completed exchanges and recovers recent context for Gemini', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blueant-voice-journal-'))
    directories.push(dir)
    vi.stubEnv('ANTON_JOURNAL_DIR', dir)
    appendVoiceTurn('Where is my file?', 'It is in Downloads.')
    const file = readdirSync(dir).find(name => name.endsWith('.md'))!
    expect(readFileSync(join(dir, file), 'utf8')).toContain('- voice_user: Where is my file?')
    expect(recentVoiceContext()).toContain('- voice_assistant: It is in Downloads.')
  })

  it('starts fail-soft when the journal directory is a dangling symlink', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'blueant-journal-unavailable-'))
    directories.push(tmp)
    const link = join(tmp, 'journal')
    symlinkSync(join(tmp, 'not-mounted-volume'), link)
    mocks.journalEnabled.mockReturnValue(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => startJournalCollector({ journalDir: link, intervalMs: 3_600_000 })).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[journal] screenshots dir unavailable'),
      join(link, 'screenshots'),
    )
    warn.mockRestore()
  })
})
