/**
 * Assemble the Linux Anton candidate at `dist/Anton-linux-<arch>`: the
 * bun-compiled bridge (cross-compiled, arch selectable), a Node runtime for
 * the target OS, and the built harness + c0ntext trees, laid out for the
 * generated `start-anton.sh` launcher and `anton.desktop` entry. Mirrors
 * `build-anton-macos.ts`; the scripts stay separate because each bakes in
 * its platform's archive format, directory layout, and launcher contract
 * (see scripts/AGENTS.md — platform adaptation lives in the platform's
 * script, not a shared layer).
 *
 * Owned limitations: binaries are not signed, there is no AppImage/packaging
 * step (the candidate is a directory to copy), and the desktop entry bakes
 * in the build machine's absolute bundle path.
 *
 * Usage: bun scripts/build-anton-linux.ts [x64|arm64] (default: host arch).
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(harnessRoot, '..')
const bridgeRoot = resolve(harnessRoot, 'apps', 'anton-bridge')
const contextRoot = resolve(sourceRoot, 'c0ntext')
const nodeVersion = '22.19.0'
const architectureArgument = process.argv[2] ?? (process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : undefined)
if (architectureArgument !== 'x64' && architectureArgument !== 'arm64') {
  throw new Error(`Unsupported Linux architecture: ${architectureArgument ?? 'unknown'} (use x64 or arm64)`)
}
const architecture: 'x64' | 'arm64' = architectureArgument
// Never assemble into a live bundle: build the complete side-by-side
// candidate, exactly like the macOS flow.
const appRoot = resolve(harnessRoot, 'dist', `Anton-linux-${architecture}`)
const nodeHome = join(appRoot, 'node')
const binRoot = join(appRoot, 'bin')
const nodeArchive = `node-v${nodeVersion}-linux-${architecture}.tar.gz`
const bunTarget = `bun-linux-${architecture}`

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
  const temporary = mkdtempSync(join(tmpdir(), 'anton-node-linux-'))
  const archive = join(temporary, nodeArchive)
  const checksums = join(temporary, 'SHASUMS256.txt')
  try {
    run(['curl', '--fail', '--location', '--silent', '--show-error', '--output', archive, `${baseUrl}/${nodeArchive}`])
    run(['curl', '--fail', '--location', '--silent', '--show-error', '--output', checksums, `${baseUrl}/SHASUMS256.txt`])
    const expected = readFileSync(checksums, 'utf8').split('\n').find(line => line.endsWith(`  ${nodeArchive}`))?.split(/\s+/)[0]
    if (expected === undefined || sha256(archive) !== expected) throw new Error(`Node ${nodeVersion} linux-${architecture} archive checksum verification failed`)
    run(['tar', '-xzf', archive, '-C', temporary])
    cpSync(join(temporary, `node-v${nodeVersion}-linux-${architecture}`), destination, { recursive: true })
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
    join(binRoot, 'anton-bridge'),
    join(nodeHome, 'bin', 'node'),
    join(bundledHarness, 'apps', 'cli', 'lib', 'bin.js'),
    join(bundledContextPlugin, 'lib', 'index.js'),
    join(bundledContextPlugin, 'lib', 'client.js'),
    join(appRoot, 'start-anton.sh'),
    join(appRoot, 'anton.desktop'),
  ]
  for (const path of required) {
    if (!existsSync(path)) throw new Error(`Anton Linux package is missing required runtime file: ${path}`)
  }
  for (const root of [join(bundledHarness, 'apps'), join(bundledHarness, 'packages'), bundledContextPlugin]) {
    const source = firstSourceTypeScript(root)
    if (source !== undefined) throw new Error(`Anton Linux package must not contain first-party TypeScript source: ${source}`)
  }
}

/** The launchers carry the same environment contract as macOS AntonApp.swift. */
function writeLaunchers(): void {
  writeFileSync(join(appRoot, 'start-anton.sh'), [
    '#!/bin/bash',
    '# Launch the Anton bridge with the same environment contract the macOS',
    '# app shell establishes; override the ANTON_* variables before invoking',
    '# to redirect any root.',
    'set -eu',
    'HERE="$(cd "$(dirname "$0")" && pwd)"',
    'export ANTON_DSH_ROOT="$HERE/deepseek-harness"',
    'export ANTON_CONTEXT_ROOT="$HERE/c0ntext"',
    'export ANTON_CONTEXT_PLUGIN_ROOT="$HERE/c0ntext/deepseek-harness-plugin"',
    'export ANTON_DSH_HOME="${ANTON_DSH_HOME:-$HOME/.local/share/Anton/dsh}"',
    'export ANTON_BRIDGE_CONFIG="${ANTON_BRIDGE_CONFIG:-$HOME/.local/share/Anton/bridge.json}"',
    'export ANTON_NODE_BINARY="$HERE/node/bin/node"',
    'export ANTON_CONTEXT_AUTO_START=true',
    'mkdir -p "$ANTON_DSH_HOME"',
    'exec "$HERE/bin/anton-bridge" "$@"',
    '',
  ].join('\n'))
  chmodSync(join(appRoot, 'start-anton.sh'), 0o755)
  writeFileSync(join(appRoot, 'anton.desktop'), [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Anton',
    'Comment=DeepSeek Harness agent bridge',
    `Exec=${join(appRoot, 'start-anton.sh')}`,
    'Terminal=false',
    'Categories=Development;',
    '',
  ].join('\n'))
}

if (process.platform === 'win32') throw new Error('Assemble the Linux candidate from a POSIX host (rsync and tar are required)')
if (!existsSync(harnessRoot) || !existsSync(contextRoot)) throw new Error('Expected sibling deepseek-harness and c0ntext directories')

rmSync(appRoot, { recursive: true, force: true })
mkdirSync(binRoot, { recursive: true })

run(['bun', 'build', '--compile', `--target=${bunTarget}`, '--outfile', join(binRoot, 'anton-bridge'), 'src/index.ts'], bridgeRoot)
bundledNode(nodeHome)
writeLaunchers()
chmodSync(join(binRoot, 'anton-bridge'), 0o755)

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
console.log('Not signed; copy the directory to the target Linux machine and run ./start-anton.sh (or install anton.desktop).')
