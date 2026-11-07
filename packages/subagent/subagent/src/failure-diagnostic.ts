/** Bounded local failure text for the parent settlement notice. @module */

const MAX_LOCAL_DIAGNOSTIC_BYTES = 2_048
const TRUNCATED = '\n[diagnostic truncated]'

/**
 * Keep durable failure prose while stripping terminal controls and common credential forms.
 * This targeted filter cannot identify arbitrary secrets embedded in unlabeled prose.
 * @param message - durable error message, never an error object or protocol payload.
 * @returns labeled diagnostic limited to 2048 UTF-8 bytes.
 */
export function localFailureDiagnostic(message: string): string {
  const safe = message
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/\bBearer\s+[^\s;,]+/gi, 'Bearer [redacted]')
    .replace(/\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;&,]+)/gi, '$1[redacted]')
    .replace(/\bsk-[a-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/gi, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
  const text = `Child failure: ${safe}`
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= MAX_LOCAL_DIAGNOSTIC_BYTES) return text
  let end = MAX_LOCAL_DIAGNOSTIC_BYTES - Buffer.byteLength(TRUNCATED)
  while (((bytes[end] as number) & 0b1100_0000) === 0b1000_0000) end--
  return bytes.subarray(0, end).toString('utf8') + TRUNCATED
}
