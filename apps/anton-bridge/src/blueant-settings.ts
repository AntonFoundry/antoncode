import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Blueant user settings: the small persisted surface behind the popup's
 * settings panel. One JSON file under the app's Blueant directory is the
 * single source of truth; both the bridge (journal loops, future surfaces)
 * and the Mac app (settings popover, session-create model application) read
 * and write through here. The in-memory copy flips on write so running
 * loops honor a change on their next tick without a restart.
 */

export interface BlueantModelSelection {
  provider: string
  model: string
}

export interface BlueantSettings {
  /** Ambient journal capture + triage loops run only when true. */
  journalEnabled: boolean
  /** Preferred model for new Blueant sessions; null = harness default. */
  model: BlueantModelSelection | null
}

const DEFAULT_SETTINGS: BlueantSettings = { journalEnabled: true, model: null }

function settingsPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'Anton', 'blueant', 'settings.json')
}

let current: BlueantSettings = loadSettings()

function loadSettings(): BlueantSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<BlueantSettings>
    const journalEnabled = typeof raw.journalEnabled === 'boolean' ? raw.journalEnabled : DEFAULT_SETTINGS.journalEnabled
    const model = isModelSelection(raw.model) ? raw.model : null
    return { journalEnabled, model }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function isModelSelection(value: unknown): value is BlueantModelSelection {
  return typeof value === 'object' && value !== null
    && typeof (value as BlueantModelSelection).provider === 'string' && (value as BlueantModelSelection).provider !== ''
    && typeof (value as BlueantModelSelection).model === 'string' && (value as BlueantModelSelection).model !== ''
}

export function getBlueantSettings(): BlueantSettings {
  return { ...current }
}

export function updateBlueantSettings(patch: Partial<BlueantSettings>): BlueantSettings {
  const next: BlueantSettings = {
    journalEnabled: typeof patch.journalEnabled === 'boolean' ? patch.journalEnabled : current.journalEnabled,
    model: patch.model === null || isModelSelection(patch.model) ? patch.model : current.model,
  }
  const path = settingsPath()
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    current = next
  } catch (error) {
    console.warn('[settings] failed to persist Blueant settings:', error)
    // Memory still flips so the running loops honor the user's intent even
    // when the disk write fails; the next successful write re-persists.
    current = next
  }
  return { ...current }
}

/** Cheap flag read for the journal loops' per-tick guard. */
export function journalEnabled(): boolean {
  return current.journalEnabled
}

// A missing settings file materializes with defaults on first write, not on
// load — reading an absent file is the normal first-boot path, not an error
// worth touching the disk for.
export function settingsFileExists(): boolean {
  return existsSync(settingsPath())
}
