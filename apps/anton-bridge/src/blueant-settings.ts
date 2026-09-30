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

/** A local wake-word model: one of the catalog engines, referenced by bare model filename. */
export interface BlueantWakeModelSelection {
  engine: 'whisper' | 'parakeet'
  file: string
}

export interface BlueantSettings {
  /** Ambient journal capture + triage loops run only when true. */
  journalEnabled: boolean
  /** Ambient wake-word listening ("hey Blueant") runs only when true. */
  wakeWordEnabled: boolean
  /** Mobile inbox polling (iCloud Drive "Anton Inbox" folder) runs only when true. */
  mobileIngestEnabled: boolean
  /** Preferred model for new Blueant sessions; null = harness default. */
  model: BlueantModelSelection | null
  /** Wake recognition model; defaults to Whisper Small. */
  wakeModel: BlueantWakeModelSelection
  /** Preferred input device id; null = system default microphone. */
  inputDevice: string | null
}

const DEFAULT_WAKE_MODEL: BlueantWakeModelSelection = { engine: 'whisper', file: 'ggml-small.bin' }

const DEFAULT_SETTINGS: BlueantSettings = {
  journalEnabled: true, wakeWordEnabled: false, mobileIngestEnabled: true, model: null,
  wakeModel: DEFAULT_WAKE_MODEL, inputDevice: null,
}

function settingsPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'Anton', 'blueant', 'settings.json')
}

let current: BlueantSettings = loadSettings()

/**
 * A wake model is accepted only when the engine is in the catalog and the
 * file is a bare `.bin` filename: the app resolves files inside its own
 * models directory, so a path-bearing or foreign-extension value must never
 * be persisted.
 */
export function isWakeModelSelection(value: unknown): value is BlueantWakeModelSelection {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as BlueantWakeModelSelection
  if (candidate.engine !== 'whisper' && candidate.engine !== 'parakeet') return false
  if (typeof candidate.file !== 'string' || candidate.file === '') return false
  if (candidate.file.includes('/') || candidate.file.includes('\\') || candidate.file.includes('..')) return false
  return candidate.file.endsWith('.bin')
}

function isInputDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function loadSettings(): BlueantSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<BlueantSettings>
    const journalEnabled = typeof raw.journalEnabled === 'boolean' ? raw.journalEnabled : DEFAULT_SETTINGS.journalEnabled
    const wakeWordEnabled = typeof raw.wakeWordEnabled === 'boolean' ? raw.wakeWordEnabled : DEFAULT_SETTINGS.wakeWordEnabled
    const mobileIngestEnabled = typeof raw.mobileIngestEnabled === 'boolean' ? raw.mobileIngestEnabled : DEFAULT_SETTINGS.mobileIngestEnabled
    const model = isModelSelection(raw.model) ? raw.model : null
    // An invalid stored wake model or microphone falls back to the default
    // rather than failing the load: settings are user data, and the app can
    // always run on the built-in model and system microphone.
    const wakeModel = isWakeModelSelection(raw.wakeModel) ? raw.wakeModel : DEFAULT_WAKE_MODEL
    const inputDevice = isInputDeviceId(raw.inputDevice) ? raw.inputDevice : null
    return { journalEnabled, wakeWordEnabled, mobileIngestEnabled, model, wakeModel, inputDevice }
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
  return { ...current, wakeModel: { ...current.wakeModel } }
}

export function updateBlueantSettings(patch: Partial<BlueantSettings>): BlueantSettings {
  const next: BlueantSettings = {
    journalEnabled: typeof patch.journalEnabled === 'boolean' ? patch.journalEnabled : current.journalEnabled,
    wakeWordEnabled: typeof patch.wakeWordEnabled === 'boolean' ? patch.wakeWordEnabled : current.wakeWordEnabled,
    mobileIngestEnabled: typeof patch.mobileIngestEnabled === 'boolean' ? patch.mobileIngestEnabled : current.mobileIngestEnabled,
    model: patch.model === null || isModelSelection(patch.model) ? patch.model : current.model,
    wakeModel: isWakeModelSelection(patch.wakeModel) ? patch.wakeModel : current.wakeModel,
    inputDevice: patch.inputDevice === undefined ? current.inputDevice : (isInputDeviceId(patch.inputDevice) ? patch.inputDevice : null),
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
  return getBlueantSettings()
}

/** Cheap flag read for the journal loops' per-tick guard. */
export function journalEnabled(): boolean {
  return current.journalEnabled
}

export function mobileIngestEnabled(): boolean {
  return current.mobileIngestEnabled
}

// A missing settings file materializes with defaults on first write, not on
// load — reading an absent file is the normal first-boot path, not an error
// worth touching the disk for.
export function settingsFileExists(): boolean {
  return existsSync(settingsPath())
}
