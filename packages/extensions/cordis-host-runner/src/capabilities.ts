/**
 * Static capability pre-flight for dynamic Package source.
 *
 * At `define` time we scan the Host and Client function bodies for markers of
 * capability-bearing surfaces (shell execution, filesystem access, network
 * egress). The detected list rides on the Package record so the approval UI
 * can show the user WHAT a Plugin will touch BEFORE they authorize its run —
 * the pre-flight half of the plugin-install loop. Detection is best-effort
 * static scanning, not a security boundary: the sandbox remains the enforced
 * boundary, and denials keep failing soft with markers.
 */

export type DynamicCapability = 'shell' | 'fs' | 'net'

const MARKERS: ReadonlyArray<readonly [DynamicCapability, RegExp]> = [
  ['shell', /shell\s*\.\s*(run|start|resolve)\b/],
  ['shell', /ctx\s*\.\s*shell\b/],
  ['shell', /\bshellPolicy\b/],
  ['fs', /\bfs\s*\.\s*(readText|writeText|resolve|list|remove|mkdir)\b/],
  ['fs', /ctx\s*\.\s*fs\b/],
  ['net', /\bfetch\s*\(/],
  ['net', /\bWebSocket\b/],
  ['net', /XMLHttpRequest\b/],
  ['net', /\bnet\s*\.\s*(request|connect|fetch)\b/],
]

/**
 * Detect the capability set of one Package from its source.
 * @param code - the Host and Client function bodies as authored.
 * @returns sorted, de-duplicated capability names; empty when none detected.
 */
export function detectCapabilities(code: { host?: string; client?: string }): DynamicCapability[] {
  const found = new Set<DynamicCapability>()
  for (const source of [code.host, code.client]) {
    if (source === undefined) continue
    for (const [capability, marker] of MARKERS) {
      if (marker.test(source)) found.add(capability)
    }
  }
  return [...found].sort()
}
