/**
 * The webcam settings store: effect selection and capture preferences shared
 * by every mounted webcam view. Declared at the `webcam.view` register — the
 * framework instantiates one instance and every view reads the same
 * snapshots, so a mode change in one pane applies everywhere and survives a
 * pane split. Camera identity and effect intent are per-session preferences;
 * nothing here persists to disk yet.
 * @module @deepseek-ai/dsh-client-ui-webcam/client/settings
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** The compositor effect applied to the camera background. */
export type WebcamEffect =
  /** Raw camera passthrough — no segmentation, no compositing. */
  | 'off'
  /** Replace the background with a solid studio or green-screen color. */
  | 'remove'
  /** Blur the background, strength from `blurStrength`. */
  | 'blur'
  /** Replace the background with a built-in gradient or a custom image. */
  | 'replace'

/** Solid backdrops for the `remove` effect. */
export type RemoveStyle = 'studio' | 'green'

/** Shared webcam settings (one store instance across all views). */
export interface WebcamSettingsState {
  /** The active background effect. */
  effect: WebcamEffect
  /** Blur strength, 0–100 (maps to a quarter-res gaussian radius). */
  blurStrength: number
  /** Index into the built-in gradient backdrops (replace effect). */
  backdropIndex: number
  /** Solid color used by the remove effect. */
  removeStyle: RemoveStyle
  /** Mirror the preview horizontally (selfie view). */
  mirror: boolean
  /** Preferred camera device id; undefined = the OS default. */
  deviceId: string | undefined
}

/** Annotation twin of the actions literal (declared return type). */
export type WebcamSettingsActions = {
  setEffect: (draft: WebcamSettingsState, effect: WebcamEffect) => void
  setBlurStrength: (draft: WebcamSettingsState, value: number) => void
  setBackdropIndex: (draft: WebcamSettingsState, index: number) => void
  setRemoveStyle: (draft: WebcamSettingsState, style: RemoveStyle) => void
  toggleMirror: (draft: WebcamSettingsState) => void
  setDeviceId: (draft: WebcamSettingsState, deviceId: string | undefined) => void
}

/** Shipped defaults: blur-on arrival so the first frame shows the effect. */
export const WEBCAM_SETTINGS_DEFAULTS: WebcamSettingsState = {
  effect: 'blur',
  blurStrength: 50,
  backdropIndex: 0,
  removeStyle: 'studio',
  mirror: true,
  deviceId: undefined,
}

/**
 * Create the webcam settings store handle.
 * @returns the store handle shared by every webcam view.
 */
export function createWebcamSettingsStore(): EngineStoreHandle<WebcamSettingsState, WebcamSettingsActions> {
  return defineStore({
    init: (): WebcamSettingsState => ({ ...WEBCAM_SETTINGS_DEFAULTS }),
    actions: {
      setEffect: (d, effect: WebcamEffect) => { d.effect = effect },
      setBlurStrength: (d, value: number) => { d.blurStrength = Math.min(100, Math.max(0, value)) },
      setBackdropIndex: (d, index: number) => { d.backdropIndex = index },
      setRemoveStyle: (d, style: RemoveStyle) => { d.removeStyle = style },
      toggleMirror: (d) => { d.mirror = !d.mirror },
      setDeviceId: (d, deviceId: string | undefined) => { d.deviceId = deviceId },
    },
  })
}
