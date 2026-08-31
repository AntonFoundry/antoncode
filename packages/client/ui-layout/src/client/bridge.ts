/**
 * Bridge to the Anton host process (apps/anton-bridge): the web GUI is
 * served by it, and the harness-restart control is one of its routes. The
 * restart flow is fire → wait → reload: POST the restart (the bridge may
 * drop the socket mid-call while the harness it owns goes down), poll the
 * status route until the host answers again, then reload the page so the
 * frontend re-bootstraps against the new process. A deadline bounds the
 * wait; past it the page stays as-is (the user can reload by hand).
 */

/** How long the waiting poll runs before giving up. */
const RESTART_DEADLINE_MS = 120_000
/** Poll interval while the host is down. */
const RESTART_POLL_MS = 1_000

/** Fire the harness restart; the response is best-effort by design. */
export function requestHarnessRestart(): void {
  void fetch('/bridge/api/harness/restart', { method: 'POST' }).catch(() => {})
}

/**
 * Wait for the host to come back, then reload the page.
 * @param signal - an AbortSignal cancels the wait (never reloads).
 * @returns resolved once the page reload is requested (or the wait ends).
 */
export async function waitAndReload(signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + RESTART_DEADLINE_MS
  while (signal?.aborted !== true && Date.now() < deadline) {
    try {
      const res = await fetch('/bridge/api/status', { cache: 'no-store', signal })
      if (res.ok) {
        window.location.reload()
        return
      }
    } catch { /* still down — keep polling */ }
    await new Promise(resolve => setTimeout(resolve, RESTART_POLL_MS))
  }
}
