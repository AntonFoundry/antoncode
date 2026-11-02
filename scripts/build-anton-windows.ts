/**
 * Assemble the Windows Anton candidate at `dist/Anton-windows-x64`: the
 * bun-compiled bridge (cross-compiled from any POSIX host), a Node runtime
 * for the target OS, and the built harness + c0ntext trees, laid out for the
 * generated `Start Anton.cmd` launcher. Mirrors `build-anton-macos.ts`; the
 * scripts stay separate because each bakes in its platform's archive format,
 * directory layout, and launcher contract (see scripts/AGENTS.md — platform
 * adaptation lives in the platform's script, not a shared layer).
 *
 * Owned limitations: Windows is x64 only (bun publishes no windows-arm64
 * compile target), the binary is not Authenticode-signed, and the candidate
 * is a directory to copy onto the target machine, not an installer. The full
 * pipeline is wired but first proven on real hardware at run time.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(harnessRoot, '..')
const bridgeRoot = resolve(harnessRoot, 'apps', 'anton-bridge')
const contextRoot = resolve(sourceRoot, 'c0ntext')
// Never assemble into a live bundle: build the complete side-by-side
// candidate, exactly like the macOS flow.
const appRoot = resolve(harnessRoot, 'dist', 'Anton-windows-x64')
const nodeHome = join(appRoot, 'node')
const binRoot = join(appRoot, 'bin')
const nodeVersion = '22.19.0'
const nodeArchive = `node-v${nodeVersion}-win-x64.zip`
const bunTarget = 'bun-windows-x64'

function run(command: string[], cwd = bridgeRoot): void {
  const [binary, ...args] = command
  if (binary === undefined) throw new Error('run() requires a non-empty command')
  const result = spawnSync(binary, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command.join(' ')} failed with status ${result.status}`)
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function bundledNode(destination: string): void {
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`
  const temporary = mkdtempSync(join(tmpdir(), 'anton-node-win-'))
  const archive = join(temporary, nodeArchive)
  const checksums = join(temporary, 'SHASUMS256.txt')
  try {
    run(['curl', '--fail', '--location', '--silent', '--show-error', '--output', archive, `${baseUrl}/${nodeArchive}`])
    run(['curl', '--fail', '--location', '--silent', '--show-error', '--output', checksums, `${baseUrl}/SHASUMS256.txt`])
    const expected = readFileSync(checksums, 'utf8').split('\n').find(line => line.endsWith(`  ${nodeArchive}`))?.split(/\s+/)[0]
    if (expected === undefined || sha256(archive) !== expected) throw new Error(`Node ${nodeVersion} win-x64 archive checksum verification failed`)
    // bsdtar (macOS) reads zip directly; GNU tar on a Linux build host does
    // not, so unzip is the fallback.
    const extracted = spawnSync('tar', ['-xf', archive, '-C', temporary], { stdio: 'inherit' })
    if (extracted.status !== 0) run(['unzip', '-q', archive, '-d', temporary])
    cpSync(join(temporary, `node-v${nodeVersion}-win-x64`), destination, { recursive: true })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function syncDirectory(source: string, destination: string, excludes: string[] = []): void {
  const args = ['rsync', '-a', '--delete', ...excludes.flatMap(pattern => ['--exclude', pattern]), `${source}/`, `${destination}/`]
  run(args)
}

/** Return the first source TypeScript path in a packaged first-party tree, if any. */
function firstSourceTypeScript(root: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // Third-party dependencies may intentionally carry TypeScript source; the
    // shipping invariant applies only to our first-party package trees.
    if (entry.isDirectory() && entry.name === 'node_modules') continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = firstSourceTypeScript(path)
      if (nested !== undefined) return nested
    } else if (entry.isFile()
      && !entry.name.endsWith('.d.ts')
      && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      return path
    }
  }
  return undefined
}

/**
 * Reject a candidate which cannot run the built Harness or which copied
 * readable first-party implementation TypeScript into its package
 * directories. Generated `.d.ts` declarations and third-party dependencies
 * are allowed.
 */
function assertLibOnlyHarnessBundle(): void {
  const bundledHarness = join(appRoot, 'deepseek-harness')
  const bundledContextPlugin = join(appRoot, 'c0ntext', 'deepseek-harness-plugin')
  const required = [
    join(binRoot, 'anton-bridge.exe'),
    join(nodeHome, 'node.exe'),
    join(bundledHarness, 'apps', 'cli', 'lib', 'bin.js'),
    join(bundledContextPlugin, 'lib', 'index.js'),
    join(bundledContextPlugin, 'lib', 'client.js'),
    join(appRoot, 'Start Anton.cmd'),
  ]
  for (const path of required) {
    if (!existsSync(path)) throw new Error(`Anton Windows package is missing required runtime file: ${path}`)
  }
  for (const root of [join(bundledHarness, 'apps'), join(bundledHarness, 'packages'), bundledContextPlugin]) {
    const source = firstSourceTypeScript(root)
    if (source !== undefined) throw new Error(`Anton Windows package must not contain first-party TypeScript source: ${source}`)
  }
}

/** The launcher carries the same environment contract as macOS AntonApp.swift. */
function writeLauncher(): void {
  writeFileSync(join(appRoot, 'Start Anton.cmd'), [
    '@echo off',
    'setlocal',
    'set "HERE=%~dp0"',
    'set "ANTON_DSH_ROOT=%HERE%deepseek-harness"',
    'set "ANTON_CONTEXT_ROOT=%HERE%c0ntext"',
    'set "ANTON_CONTEXT_PLUGIN_ROOT=%HERE%c0ntext\\deepseek-harness-plugin"',
    'if not defined ANTON_DSH_HOME set "ANTON_DSH_HOME=%APPDATA%\\Anton\\dsh"',
    'if not defined ANTON_BRIDGE_CONFIG set "ANTON_BRIDGE_CONFIG=%APPDATA%\\Anton\\bridge.json"',
    'set "ANTON_NODE_BINARY=%HERE%node\\node.exe"',
    'set "ANTON_CONTEXT_AUTO_START=true"',
    '"%HERE%bin\\anton-bridge.exe" %*',
    '',
  ].join('\r\n'))
}

if (process.platform === 'win32') throw new Error('Assemble the Windows candidate from a POSIX host (rsync and bsdtar/unzip are required)')
if (!existsSync(harnessRoot) || !existsSync(contextRoot)) throw new Error('Expected sibling deepseek-harness and c0ntext directories')

rmSync(appRoot, { recursive: true, force: true })
mkdirSync(binRoot, { recursive: true })

run(['bun', 'build', '--compile', `--target=${bunTarget}`, '--outfile', join(binRoot, 'anton-bridge.exe'), 'src/index.ts'], bridgeRoot)
bundledNode(nodeHome)
writeLauncher()

// Harness runs from its built lib/ tree; the same shipping excludes as macOS.
syncDirectory(harnessRoot, join(appRoot, 'deepseek-harness'), ['/.git', '/dist', '/.turbo', 'packages/*/*/src', 'apps/*/src', '*.ts', '*.tsx', '*.map', '*.bun-build', 'apps/anton-bridge/dist'])
syncDirectory(contextRoot, join(appRoot, 'c0ntext'), ['/.git', '/runtime', '__pycache__', '*.pyc', '*.ts', '*.tsx', '*.map', 'deepseek-harness-plugin/src', '/docker-compose.yml'])
writeFileSync(join(appRoot, 'c0ntext', 'docker-compose.yml'), [
  '# The c0ntext engine is decoupled from the Anton bundle: this stub',
  '# includes the standalone stack from the c0ntext checkout of the build',
  '# machine. Edit the path for the machine that runs this bundle.',
  'include:',
  `  - ${join(sourceRoot, 'c0ntext', 'docker-compose.yml')}`,
  '',
].join('\n'))
const bundledPluginManifest = join(appRoot, 'c0ntext', 'deepseek-harness-plugin', 'package.json')
if (!existsSync(bundledPluginManifest)) {
  throw new Error(`Bundled c0ntext plugin was not copied to ${bundledPluginManifest}`)
}
assertLibOnlyHarnessBundle()

console.log(`Built ${appRoot}`)
console.log('Not Authenticode-signed; copy the directory to the target Windows machine and run "Start Anton.cmd".')
