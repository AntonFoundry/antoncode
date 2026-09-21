/**
 * `dsh anton <action>`: control the local Anton app's harness through its
 * bridge API — the safe alternative to quit/kill/relaunch shell chains. A
 * restart here reloads the harness tree the bridge serves while the app
 * itself stays up; no boot of any profile happens in this process.
 * @module @deepseek-ai/dsh/anton
 */

/** Loopback bridge base URL, matching the app's default bridge port. */
function bridgeBaseUrl(): string {
  const port = Number(process.env.ANTON_BRIDGE_PORT ?? 3742)
  return `http://127.0.0.1:${port}`
}

/**
 * Run one Anton bridge control action and print the resulting status.
 * @param action - status reads; start/stop/restart are bridge lifecycle calls.
 * @returns the process exit code.
 */
export async function runAnton(action: 'status' | 'start' | 'stop' | 'restart'): Promise<number> {
  const url = action === 'status'
    ? `${bridgeBaseUrl()}/bridge/api/status`
    : `${bridgeBaseUrl()}/bridge/api/harness/${action}`
  let response: Response
  try {
    response = await fetch(url, {
      method: action === 'status' ? 'GET' : 'POST',
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`dsh anton: bridge not reachable at ${bridgeBaseUrl()} (${reason}). Is the Anton app running?`)
    return 1
  }
  const body = await response.text()
  if (!response.ok) {
    console.error(`dsh anton: ${action} failed with HTTP ${response.status}\n${body.slice(0, 2000)}`)
    return 1
  }
  console.log(body)
  return 0
}
