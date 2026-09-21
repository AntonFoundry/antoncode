import { mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mobileIngestEnabled } from './blueant-settings.ts'
import { appendEntry, journalDirectory, timestamp } from './journal.ts'

/**
 * Phase — mobile ingestion: an iOS Shortcut ("Send to Blueant") writes a
 * text file into the inbox folder in iCloud Drive; the bridge polls the
 * folder and appends each note into the ambient journal, where triage and
 * consolidation pick it up like any other captured context. Files move to
 * `.processed/` after ingestion (kept, never deleted, so a journal loss is
 * recoverable from the inbox itself).
 *
 * Polling (readdirSync) rather than a watcher keeps the bridge's dependency
 * set at zero — iCloud materializes files asynchronously, so a 15 s poll is
 * also the honest latency model. The whole loop is fail-soft: a poisoned
 * file renames to `.failed-<ts>` and the next tick continues.
 */

export interface MobileIngestOptions {
  /** Milliseconds between polls; default 15s, override for tests. */
  intervalMs?: number
  /** Where journals land; defaults to the Blueant support directory. */
  journalDir?: string
  /** The watched inbox; defaults to the iCloud Drive drop folder. */
  inboxDir?: string
  /** Maximum ingested note length; longer notes truncate. */
  maxNoteChars?: number
}

const INGEST_EXTENSIONS = new Set(['.txt', '.md'])

export function inboxDirectory(): string {
  return process.env.ANTON_INBOX_DIR
    ?? join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Anton Inbox')
}

export function startMobileIngest(options: MobileIngestOptions = {}): void {
  const intervalMs = options.intervalMs ?? 15_000
  const journalDir = options.journalDir ?? journalDirectory()
  const inboxDir = options.inboxDir ?? inboxDirectory()
  const processedDir = join(inboxDir, '.processed')
  const maxNoteChars = options.maxNoteChars ?? 4_000
  const timer = setInterval(() => {
    if (!mobileIngestEnabled()) return
    try {
      mkdirSync(inboxDir, { recursive: true })
      mkdirSync(processedDir, { recursive: true })
      for (const name of readdirSync(inboxDir)) {
        if (name.startsWith('.')) continue
        const dot = name.lastIndexOf('.')
        if (dot === -1 || !INGEST_EXTENSIONS.has(name.slice(dot).toLowerCase())) continue
        ingestFile(join(inboxDir, name), name, { journalDir, processedDir, maxNoteChars })
      }
    } catch (error) {
      console.warn('[mobile-ingest] tick failed:', error instanceof Error ? error.message : error)
    }
  }, intervalMs)
  timer.unref()
}

function ingestFile(
  path: string,
  name: string,
  ctx: { journalDir: string; processedDir: string; maxNoteChars: number },
): void {
  try {
    const raw = readFileSync(path, 'utf8').trim()
    if (raw === '') {
      moveTo(path, join(ctx.processedDir, `${name}.empty`))
      return
    }
    // Guard the journal's `## ` header convention: quoted lines stay content.
    const safe = raw.length > ctx.maxNoteChars ? `${raw.slice(0, ctx.maxNoteChars)}…` : raw
    const note = safe.split('\n').map(line => (line.startsWith('## ') ? `> ${line}` : line)).join('\n')
    appendEntry(ctx.journalDir, `## ${timestamp()}\n- source: mobile-ingest\n${note}\n\n`)
    moveTo(path, join(ctx.processedDir, name))
  } catch (error) {
    console.warn('[mobile-ingest] read failed for', name, error instanceof Error ? error.message : error)
    try {
      moveTo(path, join(ctx.processedDir, `${name}.failed-${Date.now()}`))
    } catch {
      // Unreadable and unmovable: leave it; the next tick retries with a
      // fresh failure name only after the read itself changes.
    }
  }
}

function moveTo(path: string, target: string): void {
  try {
    renameSync(path, target)
  } catch {
    // A same-name collision or transient iCloud lock: disambiguate once.
    renameSync(path, `${target}-${Date.now()}`)
  }
}
