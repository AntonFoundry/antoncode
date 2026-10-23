import { closeSync, openSync, readSync } from 'node:fs'

const MAX_RECORD_BYTES = 48
const WAIT_NS = 10_000_000n
/**
 * Host's one-shot end of the Swift → bridge → harness anonymous stdin pipe.
 * Reads no process.env value as a secret and never prints, persists or exports
 * the key. The fd is immediately replaced with /dev/null before tools spawn.
 * An ordinary standalone harness receives no seed and must fail closed.
 */
export function readNativeConsentSeed(fd = 0, deadlineMs = 2_000): Uint8Array | undefined {
  const bytes: number[] = []
  const byte = Buffer.alloc(1)
  const deadline = Date.now() + deadlineMs
  try {
    while (bytes.length <= MAX_RECORD_BYTES && Date.now() <= deadline) {
      let count: number
      try {
        count = readSync(fd, byte, 0, 1, null)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') return undefined
        // A bounded synchronous wait does not create a process.stdin stream or
        // leave a referenced libuv handle alive at shutdown.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(WAIT_NS / 1_000_000n))
        continue
      }
      if (count === 0) return undefined
      if (byte[0] === 10) {
        const encoded = Buffer.from(bytes).toString('ascii')
        if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return undefined
        const decoded = Buffer.from(encoded, 'base64')
        return decoded.length === 32 ? decoded : undefined
      }
      const value = byte[0]
      if (value === undefined) return undefined
      bytes.push(value)
    }
  } finally {
    try { closeSync(fd) } catch { /* stdin may already be closed */ }
    // Keep descriptor zero occupied so future children cannot inherit the
    // channel accidentally. The test seam uses a different descriptor.
    if (fd === 0) {
      try { openSync('/dev/null', 'r') } catch { /* absence never enables consent */ }
    }
  }
  return undefined
}
