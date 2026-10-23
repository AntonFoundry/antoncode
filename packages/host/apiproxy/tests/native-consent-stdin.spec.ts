import { randomBytes } from 'node:crypto'
import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readNativeConsentSeed } from '../src/native-consent-stdin.ts'

const files: string[] = []
const fdWith = (content: string): number => {
  const path = join(tmpdir(), `anton-native-consent-${randomBytes(12).toString('hex')}`)
  files.push(path)
  writeFileSync(path, content)
  return openSync(path, 'r')
}
afterEach(() => { for (const path of files.splice(0)) unlinkSync(path) })

describe('one-shot host stdin consent seed', () => {
  it('reads exactly one 32-byte key then closes its descriptor', () => {
    const key = randomBytes(32)
    const fd = fdWith(`${key.toString('base64')}\n`)
    expect(readNativeConsentSeed(fd)).toEqual(key)
    expect(() => closeSync(fd)).toThrow()
  })

  it.each(['', 'invalid\n', 'A'.repeat(100) + '\n', `${randomBytes(31).toString('base64')}\n`])(
    'fails closed for absent or malformed native input', (input) => {
      expect(readNativeConsentSeed(fdWith(input))).toBeUndefined()
    },
  )
})
