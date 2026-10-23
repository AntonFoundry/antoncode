import { randomBytes } from 'node:crypto'
import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readNativeConsentKey } from '../src/consent-key.ts'

const files: string[] = []
const input = (text: string): number => {
  const path = join(tmpdir(), `anton-consent-${randomBytes(12).toString('hex')}`)
  files.push(path)
  writeFileSync(path, text)
  return openSync(path, 'r')
}
afterEach(() => { for (const path of files.splice(0)) unlinkSync(path) })

it('accepts exactly 32 private bytes from a single newline-terminated record', () => {
  const key = randomBytes(32).toString('base64')
  expect(readNativeConsentKey(input(`${key}\n`))).toBe(key)
})

it.each(['', 'garbage\n', `${Buffer.alloc(31).toString('base64')}\n`, 'x'.repeat(49) + '\n'])(
  'fails closed for missing or malformed native input', (value) => {
    expect(readNativeConsentKey(input(value))).toBeUndefined()
  },
)

it('closes its input descriptor after reading', () => {
  const fd = input(`${randomBytes(32).toString('base64')}\n`)
  readNativeConsentKey(fd)
  expect(() => closeSync(fd)).toThrow()
})
