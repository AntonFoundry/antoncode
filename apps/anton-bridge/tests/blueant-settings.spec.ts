import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settingsDirectory = 'Library/Application Support/Anton/blueant'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'blueant-settings-'))
  vi.stubEnv('HOME', home)
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  rmSync(home, { recursive: true, force: true })
})

function store(): Promise<typeof import('../src/blueant-settings.ts')> {
  return import('../src/blueant-settings.ts')
}

function writeSettings(settings: Record<string, unknown>): void {
  const directory = join(home, settingsDirectory)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'settings.json'), JSON.stringify(settings))
}

describe('Blueant settings store', () => {
  it('defaults wake recognition to Whisper Small', async () => {
    const settings = await store()
    expect(settings.getBlueantSettings().wakeModel).toEqual({ engine: 'whisper', file: 'ggml-small.bin' })
  })

  it('persists one complete wake model selection', async () => {
    const settings = await store()
    expect(settings.updateBlueantSettings({
      wakeModel: { engine: 'parakeet', file: 'ggml-parakeet-tdt-0.6b-v3-q8_0.bin' },
    }).wakeModel).toEqual({ engine: 'parakeet', file: 'ggml-parakeet-tdt-0.6b-v3-q8_0.bin' })
    expect(settings.updateBlueantSettings({ wakeWordEnabled: true }).wakeModel)
      .toEqual({ engine: 'parakeet', file: 'ggml-parakeet-tdt-0.6b-v3-q8_0.bin' })
  })

  it('loads a persisted Whisper variant', async () => {
    writeSettings({ wakeModel: { engine: 'whisper', file: 'ggml-tiny-v2.bin' } })
    const settings = await store()
    expect(settings.getBlueantSettings().wakeModel).toEqual({ engine: 'whisper', file: 'ggml-tiny-v2.bin' })
  })

  it('rejects path-bearing or unsupported wake models', async () => {
    const settings = await store()
    expect(settings.isWakeModelSelection({ engine: 'whisper', file: '../secret.bin' })).toBe(false)
    expect(settings.isWakeModelSelection({ engine: 'whisper', file: 'models/base.bin' })).toBe(false)
    expect(settings.isWakeModelSelection({ engine: 'other', file: 'ggml-small.bin' })).toBe(false)
    expect(settings.isWakeModelSelection({ engine: 'whisper', file: 'ggml-small.txt' })).toBe(false)
  })

  it('defaults the microphone to the system default', async () => {
    const settings = await store()
    expect(settings.getBlueantSettings().inputDevice).toBeNull()
  })

  it('persists a microphone selection and clears it back to the default', async () => {
    const settings = await store()
    expect(settings.updateBlueantSettings({ inputDevice: 'BuiltInMic:1' }).inputDevice).toBe('BuiltInMic:1')
    const onDisk = JSON.parse(readFileSync(join(home, settingsDirectory, 'settings.json'), 'utf8')) as {
      inputDevice: unknown
    }
    expect(onDisk.inputDevice).toBe('BuiltInMic:1')
    expect(settings.updateBlueantSettings({ inputDevice: null }).inputDevice).toBeNull()
  })

  it('keeps the stored microphone when a patch omits it', async () => {
    const settings = await store()
    settings.updateBlueantSettings({ inputDevice: 'External Mic' })
    expect(settings.updateBlueantSettings({ wakeWordEnabled: true }).inputDevice).toBe('External Mic')
  })

  it('loads a persisted microphone from disk', async () => {
    writeSettings({ inputDevice: 'USB Mic' })
    const settings = await store()
    expect(settings.getBlueantSettings().inputDevice).toBe('USB Mic')
  })

  it('treats an empty microphone string as the system default', async () => {
    writeSettings({ inputDevice: '' })
    const settings = await store()
    expect(settings.getBlueantSettings().inputDevice).toBeNull()
  })
})
