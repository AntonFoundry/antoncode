/** Read references from the credentials document the app writes for its harnesses. */

/** Escape a literal string for use inside a `RegExp` source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Read one reference from a credentials document.
 *
 * The document is versioned YAML — a top-level `version` with every reference
 * under `refs` (`.credentials.yaml`) — and builds before that layout wrote
 * references as flat top-level `KEY: value` lines. Both layouts must resolve:
 * a format upgrade an indent-blind line scan cannot follow launches the harness
 * with an empty key, and then every authenticated memory request fails with
 * HTTP 401 while the engine itself stays reachable and reports healthy.
 * @param text - the full credentials document.
 * @param name - reference name to read, for example `ANTON_CONTEXT_API_KEY`.
 * @returns the reference value, or `''` when the document does not carry it.
 */
export function credentialRef(text: string, name: string): string {
  const match = new RegExp(`^[ \\t]*${escapeRegExp(name)}:[ \\t]*(?<value>.*)$`, 'mu').exec(text)
  const raw = match?.groups?.value?.trim() ?? ''
  if (raw === '') return ''
  const quoted = /^(?<quote>['"])(?<inner>.*)\k<quote>$/u.exec(raw)
  if (quoted?.groups?.inner !== undefined) return quoted.groups.inner.trim()
  // An unquoted value ends where a YAML comment starts.
  return raw.replace(/[ \t]+#.*$/u, '').trim()
}
