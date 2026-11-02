/**
 * Browser half of the webcam plugin: registers the WM's webcam-view slot
 * with a GPU-composited camera view bound to the shared capture engine.
 * The engine, its stabilizer, and the settings store are created once in
 * this closure; every mounted view shares them and holds one refcounted
 * capture lease.
 * @module @deepseek-ai/dsh-client-ui-webcam/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ui-theme Context merge carrying theme tokens.
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { CameraEngine } from './engine.js'
import { createWebcamSettingsStore } from './settings.js'
import { WebcamView } from './WebcamView.js'

export const inject = ['slots', 'theme']

/**
 * Register the webcam-view occupant. `M-x webcam` (C-x v) opens the shared
 * `buffer:webcam` buffer; this component attaches to the engine and renders
 * the live composited feed for its leaf.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const settings = createWebcamSettingsStore().create()
  const engine = new CameraEngine()
  // The engine owns the MediaStream and the loaded model; it stops both when
  // the plugin unloads, regardless of outstanding view leases.
  ctx.effect(() => () => { engine.dispose() }, 'ui-webcam: engine lifecycle')

  ctx.slots.inject('webcam.view', () => ctx.slots.register({
    name: 'webcam.view',
    inject: () => {
      return {
        acquire: (deviceId: string | undefined) => engine.acquire(deviceId),
        settingsActions: settings.actions,
        themeTokens: () => ctx.theme.getTheme().active.tokens,
        hooks: { settings },
      }
    },
  }, WebcamView))
}
