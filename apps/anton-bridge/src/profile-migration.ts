/** One-time migrations of the profile patches earlier Anton bridges wrote. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Remove the `tools` row earlier bridges wrote into each profile patch. The
 * 0.2 `tools` service accepts no options (`mode` and paged presentation were
 * removed), so a row setting `mode` fails its config and every tool-using
 * plugin, the agent loop included, waits forever. The row runs from its
 * `- id: tools` line to the comment block or list item that opens the next
 * row; the comment block directly above it describes it and goes with it.
 * The untouched original is kept as `cordis.patch.yml.pre-0.2`.
 * @param patchPath - one profile's cordis.patch.yml.
 */
export function removeObsoleteToolsRow(patchPath: string): void {
  if (!existsSync(patchPath)) return
  const text = readFileSync(patchPath, 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trimEnd() === '- id: tools')
  if (start === -1) return
  const isRowStart = (line: string): boolean => line.startsWith('- ')
  const isComment = (line: string): boolean => line.startsWith('#')
  let end = start + 1
  while (end < lines.length && !isRowStart(lines[end] ?? '')) end += 1
  // A comment block (and blank lines) directly above the next row belongs to it.
  while (end > start + 1 && (isComment(lines[end - 1] ?? '') || (lines[end - 1] ?? '').trim() === '')) end -= 1
  if (!lines.slice(start, end).some(line => /^\s+mode:/.test(line))) return
  let from = start
  while (from > 0 && isComment(lines[from - 1] ?? '')) from -= 1
  const backup = `${patchPath}.pre-0.2`
  if (!existsSync(backup)) writeFileSync(backup, text)
  const next = [...lines.slice(0, from), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n')
  writeFileSync(patchPath, next.trim() === '' ? '[]\n' : next)
  console.info(`Removed the obsolete tools row from ${patchPath} (original kept as ${backup})`)
}

/** Replace Anton's managed desktop-tools row while preserving later user rows.
 * @param patch - existing profile patch text.
 * @returns patch with one current managed row.
 */
export function upsertDesktopToolsRow(patch: string): string {
  const marker = '# anton-desktop-tools: managed'
  const block = `${marker}\n- insert:\n    - id: anton-desktop-tools\n      name: ./plugins/anton-desktop-tools.js\n`
  const managed = /^# anton-desktop-tools: managed\r?\n- insert:\r?\n    - id: anton-desktop-tools\r?\n      name: [^\r\n]+\r?\n?/m
  if (patch.includes(marker) && !managed.test(patch)) throw new Error('Malformed managed desktop-tools row in profile patch')
  const body = patch.replace(managed, '').replace(/\n?\[\]\s*$/, '').trimEnd()
  return body === '' ? block : `${body}\n\n${block}`
}
