// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createWebcamSettingsStore, WEBCAM_SETTINGS_DEFAULTS, type WebcamSettingsState } from '../src/client/settings.js'

describe('webcam settings store', () => {
  it('seeds the shipped defaults (blur-on arrival, mirrored, default device)', () => {
    const store = createWebcamSettingsStore().create()
    expect(store.getSnapshot()).toEqual<WebcamSettingsState>({ ...WEBCAM_SETTINGS_DEFAULTS })
    expect(store.getSnapshot().effect).toBe('blur')
    expect(store.getSnapshot().deviceId).toBeUndefined()
  })

  it('setEffect switches the compositor mode', () => {
    const store = createWebcamSettingsStore().create()
    store.actions.setEffect('replace')
    expect(store.getSnapshot().effect).toBe('replace')
    store.actions.setEffect('off')
    expect(store.getSnapshot().effect).toBe('off')
  })

  it('setBlurStrength clamps into 0–100', () => {
    const store = createWebcamSettingsStore().create()
    store.actions.setBlurStrength(150)
    expect(store.getSnapshot().blurStrength).toBe(100)
    store.actions.setBlurStrength(-5)
    expect(store.getSnapshot().blurStrength).toBe(0)
    store.actions.setBlurStrength(50)
    expect(store.getSnapshot().blurStrength).toBe(50)
  })

  it('setBackdropIndex and setRemoveStyle switch replace/remove surfaces', () => {
    const store = createWebcamSettingsStore().create()
    store.actions.setBackdropIndex(3)
    expect(store.getSnapshot().backdropIndex).toBe(3)
    store.actions.setRemoveStyle('green')
    expect(store.getSnapshot().removeStyle).toBe('green')
  })

  it('toggleMirror flips the mirror flag; setDeviceId pins and clears the device', () => {
    const store = createWebcamSettingsStore().create()
    expect(store.getSnapshot().mirror).toBe(true)
    store.actions.toggleMirror()
    expect(store.getSnapshot().mirror).toBe(false)
    store.actions.toggleMirror()
    expect(store.getSnapshot().mirror).toBe(true)
    store.actions.setDeviceId('cam-2')
    expect(store.getSnapshot().deviceId).toBe('cam-2')
    store.actions.setDeviceId(undefined)
    expect(store.getSnapshot().deviceId).toBeUndefined()
  })

  it('notifies subscribers on action commits', () => {
    const handle = createWebcamSettingsStore()
    const store = handle.create()
    let seen = 0
    const un = store.subscribe(() => { seen += 1 })
    store.actions.setEffect('remove')
    un()
    store.actions.setEffect('blur')
    expect(seen).toBe(1)
  })
})
