import { expect, it } from 'vitest'
import { localFailureDiagnostic } from '../src/failure-diagnostic.ts'

it('retains failure prose while redacting common credential forms and terminal controls', () => {
  const detail = 'quota exhausted\u001b[31m; Authorization: Bearer sentinel-bearer; api_key="sentinel-key"; '
    + 'access_token=sentinel-access password=sentinel-password sk-sentinelcredentialvalue '
    + 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZW50aW5lbCJ9.c2lnbmF0dXJl; '
    + 'https://user:sentinel-url@example.test/path?token=sentinel-query\u0000 '
    + '"api_key":"sentinel-json" OPENAI_API_KEY=sentinel-env \u001b]0;sentinel-title\u0007'
  const diagnostic = localFailureDiagnostic(detail)
  expect(diagnostic).toContain('Child failure: quota exhausted')
  expect(diagnostic).not.toContain('sentinel')
  expect(diagnostic).not.toContain('\u001b')
  expect(diagnostic).not.toContain('\u0000')
  expect(diagnostic).toContain('[redacted]')
})

it('bounds UTF-8 output and marks truncation without splitting a code point', () => {
  const diagnostic = localFailureDiagnostic('😀'.repeat(2_000))
  expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThanOrEqual(2_048)
  expect(diagnostic).toContain('[diagnostic truncated]')
  expect(diagnostic).not.toContain('\ufffd')
})
