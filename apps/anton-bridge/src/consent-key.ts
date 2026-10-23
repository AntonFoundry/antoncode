import { closeSync, readSync } from 'node:fs'

/**
 * Read exactly one native-issued key from fd 0. Never place it in process.env,
 * argv, a file, or a log: those are readable by other same-user processes.
 * Standalone bridge launches without a native parent deliberately get no key.
 */
export function readNativeConsentKey(fd = 0): string | undefined {
  const bytes: number[] = []
  const byte = Buffer.alloc(1)
  try {
    while (bytes.length <= 48) {
      const count = readSync(fd, byte, 0, 1, null)
      if (count === 0) return undefined
      if (byte[0] === 10) {
        const key = Buffer.from(bytes).toString('ascii')
        if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) return undefined
        return Buffer.from(key, 'base64').length === 32 ? key : undefined
      }
      const value = byte[0]
      if (value === undefined) return undefined
      bytes.push(value)
    }
  } catch {
    // No native stdin or malformed input: fail closed, not into a fallback grant.
  } finally {
    try { closeSync(fd) } catch { /* fd 0 may already be closed */ }
  }
  return undefined
}
