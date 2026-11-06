import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { desktopTargetBuildPaths } from '../apps/desktop/scripts/desktop-build-paths.mjs'
import { downloadNodeRuntime } from './primary-runtime/prepare.ts'

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(harnessRoot, '..')
const bridgeRoot = resolve(harnessRoot, 'apps', 'anton-bridge')
const contextRoot = resolve(sourceRoot, 'c0ntext')
// Never rewrite the installed app in place: the running Harness lazily imports
// provider modules and launches rg from that tree. An in-place rsync --delete
// can therefore make a live turn lose a module or executable halfway through.
// Build into a hidden staging bundle under the repo's dist/ (a build-artifact
// directory, never the install location), then install it into ANTON_INSTALL_DIR
// (default /Applications) with rename(2) after quitting the old app; the
// replaced bundle goes to the Trash instead of accumulating beside the install
// (recoverable from the Trash for 30 days). The staging name is not a
// documented interface, so nothing outside this script targets it.
const appRoot = resolve(harnessRoot, 'dist/.anton-staging.app')
const installDir = process.env.ANTON_INSTALL_DIR ?? '/Applications'
const installedRoot = join(installDir, 'Anton.app')
const legacyPreviousRoot = join(installDir, 'Anton.previous.app')
const contents = join(appRoot, 'Contents')
const resources = join(contents, 'Resources')
const macOS = join(contents, 'MacOS')

function run(command: string[], cwd = bridgeRoot): void {
  const [binary, ...args] = command
  if (binary === undefined) throw new Error('run() requires a non-empty command')
  const result = spawnSync(binary, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command.join(' ')} failed with status ${result.status}`)
}

/**
 * Install the standalone Node the 0.2 runtime lock pins (version and SHA-256 in
 * scripts/primary-runtime/lock.json), through the same verified, hash-keyed
 * download cache the Desktop build fills.
 * @param destination - directory receiving bin/node and LICENSE.
 */
async function bundledNode(destination: string): Promise<void> {
  const target = process.arch === 'arm64' ? 'mac-arm64' : process.arch === 'x64' ? 'mac-x64' : undefined
  if (target === undefined) throw new Error(`Unsupported macOS architecture: ${process.arch}`)
  await downloadNodeRuntime(target, destination, desktopTargetBuildPaths(target).downloads)
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
 * Reject an Anton candidate which cannot run the built Harness or which copied
 * readable first-party implementation TypeScript into its package directories.
 * Generated `.d.ts` declarations and third-party dependencies are allowed.
 */
function assertLibOnlyHarnessBundle(): void {
  const bundledHarness = join(resources, 'deepseek-harness')
  const bundledContextPlugin = join(resources, 'c0ntext', 'deepseek-harness-plugin')
  const required = [
    join(resources, 'node', 'bin', 'node'),
    join(bundledHarness, 'apps', 'cli', 'lib', 'bin.js'),
    join(bundledContextPlugin, 'lib', 'index.js'),
    join(bundledContextPlugin, 'lib', 'client.js'),
  ]
  for (const path of required) {
    if (!existsSync(path)) throw new Error(`Anton package is missing required built runtime file: ${path}`)
  }
  for (const root of [join(bundledHarness, 'apps'), join(bundledHarness, 'packages'), bundledContextPlugin]) {
    const source = firstSourceTypeScript(root)
    if (source !== undefined) throw new Error(`Anton package must not contain first-party TypeScript source: ${source}`)
  }
}

/**
 * Refuse to package a bundle that carries the developer's credentials or a
 * machine-local secret file. The staging copy is what gets signed and
 * published, so this is the last point where a leaked `.env` can be caught.
 *
 * The scan covers first-party files (the workspace tree minus every
 * `node_modules`, plus the app's own Resources). Third-party packages are
 * excluded because their own test fixtures legitimately contain key-shaped
 * strings such as `-----BEGIN PRIVATE KEY-----`.
 */
function assertNoSecretsInBundle(): void {
  const forbidden = /(^|\/)\.env(\.|$)|(^|\/)\.credentials\.yaml$|(^|\/)id_rsa|\.pem$|(^|\/)\.git$/
  const secret = new RegExp([
    'sk-[A-Za-z0-9]{20,}', 'sk_[A-Za-z0-9]{20,}', 'ghp_[A-Za-z0-9]{20,}',
    // A real access key ID stands alone; inside base64 data (pdf.js's wasm) the
    // same letters run on, so the pattern requires a non-alphanumeric edge.
    '(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])', 'AIza[0-9A-Za-z_-]{30,}', 'xox[baprs]-[A-Za-z0-9-]{10,}',
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  ].join('|'))
  // Public keys third-party code ships by design: Chrome DevTools' Chrome UX
  // Report key (chrome-devtools-frontend, inside the opt-in inspector's
  // prebuilt frontend). Exempt by exact value, never by pattern.
  const publicKeys = ['AIzaSyCCSOx25vrb5z0tbedCB3_JRzzbVW6Uwgw']
  const home = homedir()
  const walk = (dir: string, visit: (path: string) => void): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        walk(join(dir, entry.name), visit)
        continue
      }
      if (entry.isFile()) visit(join(dir, entry.name))
    }
  }
  const leaks: string[] = []
  for (const root of [resources, join(resources, 'deepseek-harness')]) {
    walk(root, (path) => {
      const relative = path.slice(resources.length + 1)
      if (forbidden.test(relative)) {
        leaks.push(relative)
        return
      }
      if (!/\.(m?js|json|ya?ml|md|sh|py|txt|plist)$/.test(path)) return
      const text = publicKeys.reduce((scanned, key) => scanned.replaceAll(key, ''), readFileSync(path, 'utf8'))
      if (secret.test(text) || text.includes(home)) leaks.push(relative)
    })
  }
  if (leaks.length > 0) {
    throw new Error(`Anton bundle would ship credentials or secret files:\n${[...new Set(leaks)].sort().join('\n')}`)
  }
}


function appIcon(destination: string): void {
  const source = join(bridgeRoot, 'macos', 'AppIcon.png')
  const temporary = mkdtempSync(join(tmpdir(), 'anton-icon-'))
  const iconset = join(temporary, 'Anton.iconset')
  mkdirSync(iconset)
  try {
    for (const points of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = points * scale
        const name = scale === 1 ? `icon_${points}x${points}.png` : `icon_${points}x${points}@2x.png`
        run(['sips', '-z', String(pixels), String(pixels), source, '--out', join(iconset, name)])
      }
    }
    run(['iconutil', '-c', 'icns', iconset, '-o', destination])
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.platform !== 'darwin') throw new Error('The macOS app bundle can only be built on macOS')
if (!existsSync(harnessRoot) || !existsSync(contextRoot)) throw new Error('Expected sibling deepseek-harness and c0ntext directories')

rmSync(appRoot, { recursive: true, force: true })
mkdirSync(join(resources, 'bin'), { recursive: true })
mkdirSync(macOS, { recursive: true })

run(['bun', 'build', '--compile', '--outfile', join(resources, 'bin', 'anton-bridge'), 'src/index.ts'], bridgeRoot)
await bundledNode(join(resources, 'node'))
cpSync(join(bridgeRoot, 'macos', 'Info.plist'), join(contents, 'Info.plist'))
appIcon(join(resources, 'Anton.icns'))
// Desktop tools plugin (browser driver + notifications) the bridge copies into
// the main profile. Built separately from the compiled bridge because the
// Harness loader imports it as a profile-local ESM module.
mkdirSync(join(resources, 'plugins'), { recursive: true })
run(['bun', 'build', '--target', 'node', '--format', 'esm',
  '--outfile', join(resources, 'plugins', 'anton-desktop-tools.js'), 'src/desktop-tools.ts'], bridgeRoot)
run(['swiftc', '-parse-as-library',
  '-framework', 'Cocoa',
  join(bridgeRoot, 'macos', 'AntonApp.swift'),
  join(bridgeRoot, 'macos', 'NativeConsentCode.swift'),
  '-o', join(macOS, 'Anton')])

// Harness runs from its built lib/ tree. The workspace's own src/ dirs and
// every *.ts/*.tsx file are excluded so the bundle carries no readable
// TypeScript; node_modules dependencies keep their src/ (some, like koffi,
// ship their runtime JS there). Stale bun-build bridge artifacts are dead
// weight. Keep node_modules: workspace symlinks remain valid because the
// whole tree is copied together.
syncDirectory(harnessRoot, join(resources, 'deepseek-harness'), ['/.git', '/.github', '/.gitlab-ci.yml', '/.gitignore', '/.gitattributes',
  // Credentials and machine-local state never enter a distributed bundle.
  // `.env` in particular is the developer's real key file.
  '/.env', '/.env.*', '/.pnpm-store', '/.claude', '/.commandcode', '/.tmp', '/tmp', '/dsh-session', '/plugins',
  '/.DS_Store', '**/.DS_Store',
  // Package-manager bin shims and metadata embed the build machine's absolute
  // paths and are never read by the packaged runtime.
  'node_modules/.bin', 'node_modules/.cache', 'node_modules/.modules.yaml', 'node_modules/.pnpm-workspace-state-v1.json',
  '/command-code-session*.html', '/graphify-out', '/.rgignore', '/.jscpd.json',
  '/dist', '/dist *', '/.turbo', 'packages/*/*/src', 'apps/*/src', '*.ts', '*.tsx', '*.map', '*.bun-build', 'apps/anton-bridge/dist', 'apps/*/dist *',
  // Repository-only surfaces never needed at runtime: internal notes and
  // planning docs, generated docs and the website projection, build scripts,
  // and the runnable-examples leaves. Shipping them leaks internal material
  // and adds dead weight; agents load AGENTS.md from their workspace, not
  // from the app bundle.
  '/*.md', '/.agents/notes', '/docs', '/website', '/scripts', '/examples',
  // Dev-run residue and repo-local tooling configs: never runtime inputs.
  '/.sessions', '/.artifacts', '/knip.json', '/lefthook.yml', '/CONTRIBUTING.i18n.yaml',
  // Port checkpoints, the visual baseline, and Electron packaging output are
  // repository-only; the last alone is over a gigabyte.
  '/.anton-port', '/.anton-visual-baseline', 'apps/*/.desktop-build',
  // Electron packaging templates; the bundled runtime never reads them.
  'apps/desktop/.env.*',
  'tsconfig*.tsbuildinfo', '/.oxlintrc.json', '/.oxlintrc.staged.json',
  // The bridge ships as the compiled binary plus its plugin; its source,
  // Swift project, vault LaunchAgent, and stale native build dirs carry
  // machine-local absolute paths.
  '/apps/anton-bridge',
  // Tests and their snapshots are never runtime inputs; fixtures also carry
  // machine-specific paths in expected output.
  'apps/*/tests', 'packages/*/*/tests',
  // tsc emits tests alongside declarations; the compiled specs embed the
  // build machine's absolute import paths.
  'apps/*/lib/types/tests', 'packages/*/*/lib/types/tests',
  'node_modules/.vitest-cache', 'node_modules/.vite'])
// Anton bundles the memory-service client plugin only. The service itself is
// a separate product reached over its configured endpoint — no service
// implementation, configuration, or infrastructure files enter the bundle.
syncDirectory(join(contextRoot, 'deepseek-harness-plugin'), join(resources, 'c0ntext', 'deepseek-harness-plugin'), ['/src', '/tests', '/README.md', '/CHANGELOG.md', '/pnpm-lock.yaml', '/tsconfig.json', '/tsdown.config.ts', '*.ts', '*.tsx', '*.map',
  // Package-manager shims and metadata embed this machine's absolute paths;
  // the plugin resolves its real dependencies without them.
  'node_modules/.bin', 'node_modules/.cache', 'node_modules/.modules.yaml', 'node_modules/.ignored',
  'node_modules/.vitest-cache', 'node_modules/.vite',
  'node_modules/.pnpm-workspace-state-v1.json'])
// Fail the candidate build rather than shipping a bridge which can listen but
// cannot launch Harness because its memory plugin is absent.
const bundledPluginManifest = join(resources, 'c0ntext', 'deepseek-harness-plugin', 'package.json')
if (!existsSync(bundledPluginManifest)) {
  throw new Error(`Bundled c0ntext plugin was not copied to ${bundledPluginManifest}`)
}
assertLibOnlyHarnessBundle()
assertNoSecretsInBundle()

/**
 * End-to-end boot smoke: run the staged bridge exactly as the app would
 * (temp DSH_HOME, private ports, bundled node) and require the harness to
 * reach ready. This exercises the full profile composition — every plugin
 * the app will load, including profile-linked dev plugins — so a broken
 * entry fails the build instead of shipping a bundle that dies on launch.
 * The bridge keeps running once ready, so the spawnSync timeout is the
 * ordinary stop for a passing run; readiness prints `dsh web:` long before.
 */
function smokeBootStaging(): void {
  const tempHome = mkdtempSync(join(tmpdir(), 'anton-smoke-'))
  const bridgeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ANTON_DSH_ROOT: join(resources, 'deepseek-harness'),
    ANTON_CONTEXT_PLUGIN_ROOT: join(resources, 'c0ntext', 'deepseek-harness-plugin'),
    ANTON_DSH_HOME: join(tempHome, 'dsh'),
    ANTON_BRIDGE_PORT: '3797',
    ANTON_HARNESS_PORT: '3197',
    ANTON_NODE_BINARY: join(resources, 'node', 'bin', 'node'),
    ANTON_AUTO_START: 'true',
    // The smoke must not touch the installed app's state: its bridge config,
    // the user's launcher in ~/.local/bin, and the auto-repair agent (which
    // reads the live Application Support logs and swaps the app in place).
    ANTON_BRIDGE_CONFIG: join(tempHome, 'bridge.json'),
    ANTON_INSTALL_CLI: 'false',
    ANTON_AUTO_REPAIR: 'false',
  }
  let output = ''
  try {
    const result = spawnSync(join(resources, 'bin', 'anton-bridge'), [], {
      env: bridgeEnv, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGTERM',
    })
    output = `${result.stdout}\n${result.stderr}`
    if (!output.includes('dsh web:')) {
      throw new Error(`boot smoke failed — the staged harness never reached ready. Last output:\n${output.split('\n').slice(-40).join('\n')}`)
    }
    // A plugin that fails to load is skipped and the harness still prints its
    // ready line, so a degraded boot must fail the candidate explicitly.
    const degraded = output.split('\n').filter(line => /degraded boot|failed to apply loader entry/.test(line))
    if (degraded.length > 0) {
      throw new Error(`boot smoke failed — the staged harness reached ready with plugins missing:\n${[...new Set(degraded)].join('\n')}`)
    }
    console.log('Boot smoke passed: staged harness reached ready under the full profile composition')
    const repair = spawnSync(join(resources, 'node', 'bin', 'node'), [
      join(resources, 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'),
      '--profile', 'repair', '--dump-config',
    ], {
      env: { ...process.env, DSH_HOME: bridgeEnv.ANTON_DSH_HOME },
      encoding: 'utf8', timeout: 30_000,
    })
    if (repair.status !== 0 || !repair.stdout.includes('headless-runner')) {
      throw new Error(`boot smoke failed — the staged repair profile cannot compose. Output:\n${repair.stdout}\n${repair.stderr}`)
    }
    console.log('Boot smoke passed: staged repair profile includes the one-shot runner')
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
}
smokeBootStaging()
run(['codesign', '--force', '--sign', '-', '-i', 'dev.antoncode.anton.bridge', '-r=designated => identifier "dev.antoncode.anton.bridge"', join(resources, 'bin', 'anton-bridge')])
run(['codesign', '--force', '--sign', '-', '-i', 'dev.antoncode.anton.node', '-r=designated => identifier "dev.antoncode.anton.node"', join(resources, 'node', 'bin', 'node')])
run(['codesign', '--force', '--sign', '-', '-i', 'dev.antoncode.anton', '-r=designated => identifier "dev.antoncode.anton"', appRoot])

console.log(`Built ${appRoot}`)
console.log(`Size: use du -sh ${appRoot}`)
if (process.env.ANTON_BUILD_ONLY === '1') {
  console.log('Build-only mode: staged app is signed and smoke-tested; installed Anton was not changed')
  process.exit(0)
}

// Install: keep the outgoing bundle for rollback, then relaunch. The normal
// path refuses to touch a running app — quit Anton before rebuilding. The
// in-place path (ANTON_IN_PLACE_SWAP=1, used by the recovery repair agent)
// swaps without quitting: running processes keep their open file handles and
// the next bridge/harness start picks up the new bundle.
const inPlaceSwap = process.env.ANTON_IN_PLACE_SWAP === '1'
if (!inPlaceSwap) {
  // Quit the running app first: graceful AppleEvent quit, then a bounded
  // wait, then force-kill stragglers. Owning the quit makes the whole flow
  // one command — build, smoke, swap, launch, verify.
  const running = spawnSync('pgrep', ['-f', 'Anton\\.app/Contents'], { encoding: 'utf8' })
  if (running.status === 0) {
    console.log('Anton is running; quitting it for the rebuild')
    spawnSync('osascript', ['-e', 'quit app "Anton"'], { stdio: 'ignore' })
    for (let elapsed = 0; elapsed < 10_000; elapsed += 500) {
      if (spawnSync('pgrep', ['-f', 'Anton\\.app/Contents'], { encoding: 'utf8' }).status !== 0) break
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
    if (spawnSync('pgrep', ['-f', 'Anton\\.app/Contents'], { encoding: 'utf8' }).status === 0) {
      spawnSync('pkill', ['-f', 'Anton\\.app/Contents'], { stdio: 'ignore' })
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)
    }
    if (spawnSync('pgrep', ['-f', 'Anton\\.app/Contents'], { encoding: 'utf8' }).status === 0) {
      throw new Error('Anton processes did not stop; refusing to swap the bundle under a running app')
    }
    // The process list can clear just before the bridge releases its listener.
    // Do not install and relaunch into that short-lived port race.
    for (let elapsed = 0; elapsed < 10_000; elapsed += 250) {
      const bridge = spawnSync('curl', ['--fail', '--silent', '--max-time', '1', 'http://127.0.0.1:3742/bridge/api/status'], { encoding: 'utf8' })
      if (bridge.status !== 0) break
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
    }
    if (spawnSync('curl', ['--fail', '--silent', '--max-time', '1', 'http://127.0.0.1:3742/bridge/api/status'], { encoding: 'utf8' }).status === 0) {
      throw new Error('Anton bridge is still listening; refusing to replace the bundle while the old runtime is alive')
    }
  }
}
/**
 * Move a path to the Trash via Finder (recoverable for 30 days), waiting for
 * it to disappear so a subsequent install never collides with it.
 */
function trashPath(target: string): void {
  const moved = spawnSync('osascript', ['-e', `tell application "Finder" to delete POSIX file ${JSON.stringify(target)}`], { encoding: 'utf8' })
  if (moved.status !== 0) throw new Error(`Failed to move ${target} to the Trash: ${moved.stderr}`)
  for (let elapsed = 0; elapsed < 30_000; elapsed += 250) {
    if (!existsSync(target)) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  }
  throw new Error(`${target} is still present after moving it to the Trash`)
}

// No previous-generation bundle is kept beside the install anymore: retire a
// leftover from the old scheme, then trash the outgoing install itself.
if (existsSync(legacyPreviousRoot)) {
  console.log(`Moving leftover ${legacyPreviousRoot} to the Trash`)
  trashPath(legacyPreviousRoot)
}
if (existsSync(installedRoot)) trashPath(installedRoot)
// The staging bundle lives in the repo's dist/ while the install dir may be
// another volume (/Applications on a separate disk): rename(2) then EXDEV
// fallback to ditto, which preserves the bundle's symlinks verbatim.
try {
  renameSync(appRoot, installedRoot)
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  run(['ditto', appRoot, installedRoot])
  rmSync(appRoot, { recursive: true, force: true })
}
// One-time migration: earlier builds installed into the repo's dist/. A stale
// copy there would shadow nothing, but LaunchServices could pick it up; remove
// it once the real install location owns the app.
const legacyInstall = resolve(harnessRoot, 'dist/Anton.app')
if (legacyInstall !== installedRoot && existsSync(legacyInstall)) {
  rmSync(legacyInstall, { recursive: true, force: true })
  console.log(`Removed legacy install at ${legacyInstall}`)
}
if (inPlaceSwap) {
  console.log(`Swapped ${installedRoot} in place; the outgoing bundle went to the Trash. Restart the harness to activate it.`)
} else {
  run(['open', installedRoot])
  // Own the launch: a queued launch can lose the race with the last dying
  // process of the previous install, so verify the tray came up and retry
  // once before reporting success. A launch that still fails is a loud
  // warning, not a failed build — the bundle itself is already installed.
  const trayUp = (): boolean =>
    spawnSync('pgrep', ['-f', 'Anton\\.app/Contents/MacOS/Anton'], { encoding: 'utf8' }).status === 0
  let launched = false
  for (let elapsed = 0; elapsed < 15_000; elapsed += 1_000) {
    if (trayUp()) { launched = true; break }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  }
  if (!launched) {
    console.warn('Anton did not appear within 15s; retrying launch once')
    run(['open', installedRoot])
    for (let elapsed = 0; elapsed < 15_000; elapsed += 1_000) {
      if (trayUp()) { launched = true; break }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
    }
  }
  console.log(launched
    ? `Installed ${installedRoot} and Anton is running; the outgoing bundle went to the Trash`
    : `Installed ${installedRoot} but Anton did not launch — open it manually. The outgoing bundle is in the Trash`)
}
