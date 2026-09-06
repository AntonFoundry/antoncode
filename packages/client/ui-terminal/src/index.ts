/**
 * Node half of the terminal plugin: nothing to mount server-side — the
 * interactive PTY sessions live behind the host `term` RPC domain, and the
 * browser half registers the WM's terminal-view slot.
 * @module @deepseek-ai/dsh-client-ui-terminal
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'ui-terminal'

// No `inject`: `slots` is a client-runtime (browser) service — a host-side
// dependency on it leaves this entry pending forever and fails boot. Ordering
// with the slots provider belongs to the browser half alone.

/** Node-half apply: no server-side contributions. */
export function apply(_ctx: Context): void {}
