/** Public dsh launch resolution for the TypeScript SDK. */

import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  installedDshBin,
  resolveDshNodeLaunchFromManifests,
  resolveDshBinFromManifests,
  resolveDshLaunch,
} from '../src/launch.ts'

const cleanups: string[] = []
afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true })
})

function manifestPair(dsh: object, client: object): { dshUrl: string; clientUrl: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sdk-manifests-'))
  cleanups.push(root)
  const dshPath = join(root, 'dsh-package.json')
  const clientPath = join(root, 'client-package.json')
  writeFileSync(dshPath, JSON.stringify(dsh))
  writeFileSync(clientPath, JSON.stringify(client))
  return {
    dshUrl: pathToFileURL(dshPath).href,
    clientUrl: pathToFileURL(clientPath).href,
    root,
  }
}

describe('SDK dsh launch resolution', () => {
  it('resolves the same-version installed dsh entry by default', () => {
    const runtimeManifestUrl = import.meta.resolve('@deepseek-ai/dsh/package.json')
    const runtimeManifest = JSON.parse(readFileSync(new URL(runtimeManifestUrl), 'utf8')) as { bin: { anton: string } }
    expect(runtimeManifest.bin.anton).toBe('lib/bin.js')
    const bin = installedDshBin()
    expect(bin.endsWith(join('apps', 'cli', 'lib', 'bin.js'))).toBe(true)
    const launch = resolveDshLaunch()
    expect(launch.command).toBe(process.execPath)
    expect(launch.args).toEqual(existsSync(bin)
      ? [bin, '--profile', 'sdk']
      : [
        '--import', import.meta.resolve('tsx/esm'), resolve(bin, '..', '..', 'src/bin.ts'),
        '--profile', 'sdk',
        '--patch', resolve(bin, '..', '..', 'src/sdk-source.cordis.patch.yml'),
      ])
    expect(launch.initializeTimeoutMs).toBe(DEFAULT_INITIALIZE_TIMEOUT_MS)
    expect(launch.description).toBe('dsh profile "sdk"')
  })

  it('makes every filesystem input absolute before spawn and preserves patch order', () => {
    const caller = resolve('/tmp', 'sdk-launch-caller')
    const launch = resolveDshLaunch({
      dshBin: './bin/dsh',
      profile: 'custom-sdk',
      patches: ['./first.yml', '../second.yml'],
      dshHome: './home',
      processCwd: './worker',
      env: { PATH: '/bin', DSH_HOME: '/stale' },
      initializeTimeoutMs: 123,
      requestTimeoutMs: 456,
      shutdownTimeoutMs: 789,
      disposeEofGraceMs: 12,
      disposeGraceMs: 34,
    }, caller)
    expect(launch).toMatchObject({
      command: process.execPath,
      args: [
        join(caller, 'bin/dsh'),
        '--profile', 'custom-sdk',
        '--patch', join(caller, 'first.yml'),
        '--patch', resolve(caller, '../second.yml'),
      ],
      cwd: join(caller, 'worker'),
      description: 'dsh profile "custom-sdk"',
      initializeTimeoutMs: 123,
      requestTimeoutMs: 456,
      shutdownTimeoutMs: 789,
      disposeEofGraceMs: 12,
      disposeGraceMs: 34,
    })
    expect(launch.environment()).toEqual({ PATH: '/bin', DSH_HOME: join(caller, 'home') })
  })

  it.each(['lib/bin.js', { anton: 'lib/bin.js' }, { dsh: 'lib/bin.js' }])('falls back to the same package source entry through an absolute tsx loader (%j)', (bin) => {
    const pair = manifestPair({ version: '1.0.0', bin }, { version: '1.0.0' })
    const sourceBin = join(pair.root, 'src/bin.ts')
    const sourcePatch = join(pair.root, 'src/sdk-source.cordis.patch.yml')
    const sourceTsconfig = join(pair.root, 'tsconfig.json')
    mkdirSync(join(pair.root, 'src'))
    writeFileSync(sourceBin, '')
    writeFileSync(sourcePatch, '[]\n')
    writeFileSync(sourceTsconfig, '{}\n')

    expect(resolveDshNodeLaunchFromManifests(pair.dshUrl, pair.clientUrl, 'file:///tsx-loader.mjs'))
      .toEqual({
        nodeArgs: ['--import', 'file:///tsx-loader.mjs', sourceBin],
        patches: [sourcePatch],
        environment: { TSX_TSCONFIG_PATH: sourceTsconfig },
      })
    expect(resolveDshNodeLaunchFromManifests(pair.dshUrl, pair.clientUrl))
      .toEqual({
        nodeArgs: ['--import', import.meta.resolve('tsx/esm'), sourceBin],
        patches: [sourcePatch],
        environment: { TSX_TSCONFIG_PATH: sourceTsconfig },
      })
  })

  it('uses the built entry when the manifest bin exists', () => {
    const pair = manifestPair({ version: '1.0.0', bin: 'lib/bin.js' }, { version: '1.0.0' })
    const bin = join(pair.root, 'lib/bin.js')
    mkdirSync(join(pair.root, 'lib'))
    writeFileSync(bin, '')

    expect(resolveDshNodeLaunchFromManifests(pair.dshUrl, pair.clientUrl)).toEqual({
      nodeArgs: [bin],
      patches: [],
      environment: {},
    })
  })

  it.each([0, 1, 2])('fails loud when a source launch is missing required file set %s', (presentCount) => {
    const pair = manifestPair({ version: '1.0.0', bin: 'lib/bin.js' }, { version: '1.0.0' })
    mkdirSync(join(pair.root, 'src'))
    const sourceFiles = ['src/bin.ts', 'src/sdk-source.cordis.patch.yml', 'tsconfig.json']
    for (const source of sourceFiles.slice(0, presentCount)) writeFileSync(join(pair.root, source), '')
    expect(() => resolveDshNodeLaunchFromManifests(pair.dshUrl, pair.clientUrl, 'file:///tsx-loader.mjs'))
      .toThrow('is missing its built executable')
  })

  it('reads explicit and inherited environments when the child starts', () => {
    const explicit: NodeJS.ProcessEnv = { MARKER: 'before' }
    const explicitLaunch = resolveDshLaunch({ dshBin: '/bin/dsh', env: explicit })
    explicit.MARKER = 'after'
    expect(explicitLaunch.environment().MARKER).toBe('after')

    const inheritedLaunch = resolveDshLaunch({ dshBin: '/bin/dsh' })
    process.env.DSH_SDK_LATE_ENV_TEST = 'late'
    try {
      expect(inheritedLaunch.environment().DSH_SDK_LATE_ENV_TEST).toBe('late')
    } finally {
      delete process.env.DSH_SDK_LATE_ENV_TEST
    }
  })

  it.each([2, '2.0.0'])(
    'rejects a dsh version that differs from the client (%j)',
    (version) => {
      const pair = manifestPair({ version, bin: 'bin.js' }, { version: '1.0.0' })
      expect(() => resolveDshBinFromManifests(pair.dshUrl, pair.clientUrl))
        .toThrow(`requires the same dsh version, got ${String(version)}`)
    },
  )

  it.each([
    { anton: './bin.js' },
    { dsh: './bin.js' },
    { anton: './bin.js', dsh: './legacy.js' },
  ])('selects the explicit profile executable from %j', (bin) => {
    const pair = manifestPair({ version: '1.0.0', bin }, { version: '1.0.0' })
    expect(resolveDshBinFromManifests(pair.dshUrl, pair.clientUrl)).toBe(join(pair.root, 'bin.js'))
  })

  it('accepts the string npm bin form', () => {
    const pair = manifestPair({ version: '1.0.0', bin: './bin.js' }, { version: '1.0.0' })
    expect(resolveDshBinFromManifests(pair.dshUrl, pair.clientUrl)).toBe(join(pair.root, 'bin.js'))
  })

  it.each([null, {}, '', { other: './bin.js' }, { anton: '' }, { anton: 1 }, { anton: '', dsh: './legacy.js' }, { dsh: 1 }])(
    'rejects a manifest without a usable dsh executable (%j)',
    (bin) => {
      const pair = manifestPair({ version: '1.0.0', bin }, { version: '1.0.0' })
      expect(() => resolveDshBinFromManifests(pair.dshUrl, pair.clientUrl))
        .toThrow('declares no usable anton or dsh profile executable')
    },
  )
})
