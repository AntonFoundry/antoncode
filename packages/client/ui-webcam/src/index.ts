/**
 * Node half of the webcam plugin: nothing to mount server-side — camera
 * capture, segmentation, and compositing all live in the browser half over
 * the WM's `webcam.view` slot; the model and wasm assets ride the web
 * frontend's static dist (apps/web/public/mediapipe).
 * @module @deepseek-ai/dsh-client-ui-webcam
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'ui-webcam'

// No `inject`: `slots` is a client-runtime (browser) service — a host-side
// dependency on it leaves this entry pending forever and fails boot. Ordering
// with the slots provider belongs to the browser half alone.

/** Node-half apply: no server-side contributions. */
export function apply(_ctx: Context): void {}
