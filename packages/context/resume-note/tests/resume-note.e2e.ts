import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { DEFAULT_NOTE_TEXT } from '@deepseek-ai/dsh-resume-note'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

// Keep the Loader config under examples so both modes exercise the same deployable
// topology: local fixture source plus bare plugins owned by the examples workspace.
const driver = fileURLToPath(new URL(
  '../../../../examples/headless-agent/tests/fixtures/resume-note-driver.ts',
  import.meta.url,
))
const configPath = fileURLToPath(new URL(
  '../../../../examples/headless-agent/tests/fixtures/resume-note.cordis.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

describe('resume-note through a real headless cordis.yml', () => {
  it('repairs the crash-open turn and appends exactly one resume note', async () => {
    let events: SessionEvent[] = []
    const { stderr } = await runLoaderSmoke({
      label: 'resume-note headless smoke',
      tempDirPrefix: 'resume-note-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')

    // The reload repaired the crash-open turn 2 with an interrupted turn/end.
    const turnEnds = events.filter((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end')
    expect(turnEnds.at(-2)?.data.reason.kind).toBe('interrupted')
    // Turn 3 (the resume turn) completed normally.
    expect(turnEnds.at(-1)?.data.reason.kind).toBe('completed')

    // Exactly one resume note, after the interrupted end, before turn 3's end.
    const notes = events.filter(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
        && event.data.source.kind === 'resume-note',
    )
    expect(notes).toHaveLength(1)
    const note = notes[0]!
    expect(note.data.source).toMatchObject({
      kind: 'resume-note',
      form: 'notice',
      summary: 'previous turn was interrupted by a harness restart',
    })
    expect(note.data.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .toBe(DEFAULT_NOTE_TEXT)
    const interruptedEnd = turnEnds.at(-2)
    if (interruptedEnd !== undefined && turnEnds.at(-1) !== undefined) {
      expect(note.seq).toBeGreaterThan(interruptedEnd.seq)
      expect(note.seq).toBeLessThan(turnEnds.at(-1)!.seq)
    }
  },
  LOADER_SMOKE_TEST_TIMEOUT_MS,
  )
})
