import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { testProfileResolution } from './profiles/headless/tests/profile-resolution.ts'

/**
 * Keyless source-launch and profile-resolution checks through the production
 * tsx ESM-only entry. The Node compatibility matrix runs this file without a
 * build; source tool execution with native/generated dependencies belongs to
 * the build-backed source-tool suite.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const antonSourceBin = 'apps/cli/src/bin.ts'

describe('anton SOURCE launcher (node --import tsx/esm)', () => {
  testProfileResolution('src')
  it('launches the source CLI without building', async () => {
    const rootPackage = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      readonly scripts?: Record<string, string>
    }
    expect(rootPackage.scripts?.anton).toBe('node --import tsx/esm apps/cli/src/bin.ts')
  })

  it('prints the launcher help for a bare invocation', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx/esm', antonSourceBin], {
      cwd: repoRoot,
      input: '',
      timeout: 25_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    if (result.timedOut) {
      throw new Error(`anton source launch did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Usage: anton')
    expect(result.stdout).toContain('Examples:')
    expect(result.stderr).toBe('')
  }, 30_000)

  it('still rejects launcher flags with no profile', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx/esm', antonSourceBin, '--patch', './extra.yml'], {
      cwd: repoRoot,
      input: '',
      timeout: 25_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--profile <name> is required')
  }, 30_000)
})
