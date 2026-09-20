import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ensureBlueantPreset, ensureBlueantProfileLink } from './blueant-preset.ts'

const bridgePort = portFromEnv('ANTON_BRIDGE_PORT', 3742)
const harnessPort = portFromEnv('ANTON_HARNESS_PORT', 3080)
const profile = process.env.ANTON_DSH_PROFILE ?? 'web'
const nodeBinary = process.env.ANTON_NODE_BINARY ?? 'node'
// The harness ships as built JavaScript (apps/cli/lib/bin.js), not source:
// no import loader is needed. A deployment that runs from source sets
// ANTON_HARNESS_LOADER=tsx/esm and points ANTON_HARNESS_ENTRY at src/bin.ts.
const harnessLoader = process.env.ANTON_HARNESS_LOADER ?? ''
const autoStart = process.env.ANTON_AUTO_START !== 'false'
const harnessUrl = `http://127.0.0.1:${harnessPort}`
const harnessWebSocketUrl = `ws://127.0.0.1:${harnessPort}`
const bridgeUrl = `http://antoncode.localhost:${bridgePort}`

let harnessProcess: Bun.Subprocess | undefined
const startedAt = new Date().toISOString()

type Downlink = '/api/events.mux' | '/api/events.host'
type BridgeSocketData = {
  downlink: Downlink
  upstream?: WebSocket
}

type BridgeConfig = {
  contextEndpoint?: string
}

function portFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a TCP port number`)
  }
  return value
}

const configPath = process.env.ANTON_BRIDGE_CONFIG ?? join(homedir(), '.anton', 'bridge.json')

function normalizeContextEndpoint(value: string): string {
  const endpoint = new URL(value.trim())
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('c0ntext endpoint must use http or https')
  }
  if (endpoint.username !== '' || endpoint.password !== '') {
    throw new Error('c0ntext endpoint must not embed credentials')
  }
  endpoint.pathname = endpoint.pathname.replace(/\/$/, '')
  endpoint.search = ''
  endpoint.hash = ''
  return endpoint.href.replace(/\/$/, '')
}

function readBridgeConfig(): BridgeConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const endpoint = (parsed as BridgeConfig).contextEndpoint
    return typeof endpoint === 'string' ? { contextEndpoint: normalizeContextEndpoint(endpoint) } : {}
  } catch {
    return {}
  }
}

function writeBridgeConfig(config: BridgeConfig): void {
  mkdirSync(dirname(configPath), { recursive: true })
  const temporary = `${configPath}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, configPath)
}

let contextEndpoint = normalizeContextEndpoint(
  process.env.ANTON_CONTEXT_ENDPOINT ?? readBridgeConfig().contextEndpoint ?? 'http://127.0.0.1:8090',
)

/** First candidate that exists on disk, else the last defined one. */
function firstDefined(candidates: readonly string[], exists: (candidate: string) => boolean = existsSync): string {
  return candidates.find(candidate => exists(candidate)) ?? candidates[candidates.length - 1] ?? ''
}

function defaultHarnessRoot(): string {
  return firstDefined([
    process.env.ANTON_DSH_ROOT,
    // This bridge lives in the Harness checkout: apps/anton-bridge/src → root.
    resolve(import.meta.dir, '..', '..', '..'),
    resolve(process.cwd(), '..', 'deepseek-harness'),
    resolve(process.cwd(), 'deepseek-harness'),
  ].filter((candidate): candidate is string => Boolean(candidate)))
}

const harnessRoot = defaultHarnessRoot()
const harnessEntry = process.env.ANTON_HARNESS_ENTRY ?? resolve(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')

/**
 * Locate the memory-plugin package the harness profile links. Development
 * uses the sibling checkout; the packaged app ships it under Resources. The
 * memory service itself is a separate product — only this client plugin
 * belongs to the app.
 */
function defaultContextPluginRoot(): string | undefined {
  return firstDefined(
    [
      process.env.ANTON_CONTEXT_PLUGIN_ROOT,
      resolve(harnessRoot, '..', 'c0ntext', 'deepseek-harness-plugin'),
      resolve(process.cwd(), '..', 'c0ntext', 'deepseek-harness-plugin'),
      resolve(process.cwd(), 'c0ntext', 'deepseek-harness-plugin'),
    ].filter((candidate): candidate is string => Boolean(candidate)),
    candidate => existsSync(join(candidate, 'package.json')),
  )
}

const bundledContextPluginRoot = defaultContextPluginRoot() ?? resolve(harnessRoot, '..', 'c0ntext', 'deepseek-harness-plugin')
// Development and the packaged app use the same profile assembly. The app
// supplies Application Support paths; checkout development gets ~/.anton/dsh
// so it cannot accidentally mutate a developer's ordinary ~/.dsh profile.
const dshHome = process.env.ANTON_DSH_HOME ?? join(homedir(), '.anton', 'dsh')

/**
 * Resolve the memory-service API key for the harness process. The credentials
 * file is flat `KEY: value` YAML written by the app; only this exact key name
 * is read and it is never logged.
 */
function resolveContextApiKey(): string {
  const existing = process.env.ANTON_CONTEXT_API_KEY?.trim()
  if (existing) return existing
  try {
    for (const line of readFileSync(join(dshHome, '.credentials.yaml'), 'utf8').split('\n')) {
      if (line.startsWith('ANTON_CONTEXT_API_KEY:')) {
        return line.slice('ANTON_CONTEXT_API_KEY:'.length).trim()
      }
    }
  } catch {
    // Absent or unreadable credentials file — the caller still launches the
    // harness; the service per-request rejection will surface the gap.
  }
  return ''
}

/**
 * The Anton profile patch body: the deployment overlay this app writes on
 * first launch (existing profiles keep whatever patch they already have).
 *
 * Memory policy is eviction-first: the plugin's evictor owns working-set
 * reduction and proactive compaction stays off, with the reactive overflow
 * recovery and manual `/compact` summarizing through a free OpenCode model
 * instead of the conversation's own paid route. Key semantics live in the
 * plugin's own schema documentation; this file only pins deployment values.
 */
function patchBody(toolsMode: string): string {
  return [
    '- id: tools',
    '  config:',
    `    mode: ${toolsMode}`,
    '- id: c0ntext-context',
    '  disabled: false',
    '  config:',
    '    endpoint: http://127.0.0.1:8090',
    '    endpointEnv: ANTON_CONTEXT_ENDPOINT',
    "    apiKey: ''",
    '    apiKeyEnv: ANTON_CONTEXT_API_KEY',
    '    projectId: c0ntext',
    '    tokenBudget: 1200',
    '    requestedZones: [goal, constraints, active_plan, active_tabs, focus_artifact, findings, next_actions, project_decisions, project_facts, project_investigations, episodes, investigations, agent_cases, hypotheses]',
    '    mirrorSession: true',
    '    # Dream distillation reuses the ongoing chat route (dreamProvider:',
    '    # current); background sweeps resolve the most recent session route.',
    '    dreamProvider: current',
    '    maxSurfaceRatio: 0.80',
    '    # Live toggle: Settings > General "Context evictor".',
    '    evictorEnabled: true',
    '    searchToolEnabled: true',
    '    imageFallbackEnabled: true',
    '    visionProvider: kimi-coding',
    '    visionModel: k3',
    '    visionMaxTokens: 1200',
    '- id: compaction-basic',
    '  config:',
    '    summarizationProvider: opencode-free',
    '    summarizationModel: nemotron-3.5-lightning-free',
    '',
  ].join('\n')
}

/**
 * The recovery profile: first-party bundles only — no memory plugin, no
 * profile-linked third-party plugins. Anything a bad plugin breaks, this
 * profile does not load, so it boots even when the main profile cannot.
 * The Swift watchdog relaunches the bridge with ANTON_DSH_PROFILE=recovery
 * after persistent harness failures; its web UI is where repair happens.
 */
function ensureRecoveryProfile(): void {
  const profileDir = join(dshHome, 'profiles', 'recovery')
  const manifestPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  mkdirSync(profileDir, { recursive: true })
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, `${JSON.stringify({
      name: 'anton-profile-recovery',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2)}\n`)
  }
  if (!existsSync(patchPath)) {
    const toolsMode = process.env.ANTON_TOOLS_MODE ?? 'paged'
    writeFileSync(patchPath, ['- id: tools', '  config:', `    mode: ${toolsMode}`, ''].join('\n'))
  }
}

/**
 * The repair profile: the base bundle plus the one-shot agent spine. This is
 * the composition the bridge drives automatically in recovery mode — one
 * bounded turn that diagnoses the boot failure, fixes the source, rebuilds,
 * and swaps the app bundle in place.
 */
function ensureRepairProfile(): void {
  const profileDir = join(dshHome, 'profiles', 'repair')
  const manifestPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  mkdirSync(profileDir, { recursive: true })
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, `${JSON.stringify({
      name: 'anton-profile-repair',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-agent-spine-demo'] } },
    }, null, 2)}\n`)
  }
  if (!existsSync(patchPath)) {
    const toolsMode = process.env.ANTON_TOOLS_MODE ?? 'paged'
    writeFileSync(patchPath, ['- id: tools', '  config:', `    mode: ${toolsMode}`, ''].join('\n'))
  }
}

/**
 * First-run provisioning: put a `dsh` launcher on PATH (~/.local/bin/dsh)
 * so the CLI is available from any terminal on a fresh system. Only the
 * packaged app installs it — a checkout developer already has `pnpm dsh`.
 * The launcher embeds this bundle's absolute paths (self-contained Node and
 * CLI), preferring a $DSH_ROOT override or a dev checkout when one exists.
 * Idempotent: an existing file is replaced only when it carries the Anton
 * marker line, so a user's own `dsh` script is never clobbered.
 */
function ensureDshLauncher(): void {
  if (process.env.ANTON_INSTALL_DSH_LAUNCHER === 'false') return
  // Bundle mode only: this bridge's own executable path names the app bundle
  // (.../Anton.app/Contents/Resources/bin). Path-derived, never a stat of the
  // bundle contents — sandboxed environments may deny stats inside .app
  // bundles and a false negative must not silently skip first-run setup.
  const execPath = process.execPath
  if (!execPath.includes('.app/Contents/')) return
  const resourcesRoot = resolve(execPath, '..', '..')
  const marker = '# dsh-launcher: anton'
  const script = [
    '#!/bin/sh',
    marker,
    '# dsh — DeepSeek Harness CLI launcher (installed by Anton).',
    '# Resolution: $DSH_ROOT override, a dev checkout if present, this app bundle.',
    'set -eu',
    // One home: the terminal CLI shares Anton's profiles, credentials, and
    // settings — no second configuration tree to maintain.
    'export DSH_HOME="${DSH_HOME:-$HOME/.anton/dsh}"',
    'NODE_BIN="$(command -v node || true)"',
    'REPO="$HOME/Development/Projects/ML/antoncode/deepseek-harness"',
    `BUNDLE="${resourcesRoot}"`,
    'if [ -n "${DSH_ROOT:-}" ] && [ -f "$DSH_ROOT/apps/cli/lib/bin.js" ]; then ROOT="$DSH_ROOT"',
    'elif [ -f "$REPO/apps/cli/lib/bin.js" ]; then ROOT="$REPO"',
    'elif [ -f "$BUNDLE/deepseek-harness/apps/cli/lib/bin.js" ]; then ROOT="$BUNDLE/deepseek-harness"',
    '  NODE_BIN="$BUNDLE/node/bin/node"',
    'else echo "dsh: no harness found (set DSH_ROOT or reinstall Anton)" >&2; exit 1',
    'fi',
    'if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then echo "dsh: no usable node runtime" >&2; exit 1; fi',
    'exec "$NODE_BIN" "$ROOT/apps/cli/lib/bin.js" "$@"',
  ].join('\n')
  const binDir = join(homedir(), '.local', 'bin')
  const launcher = join(binDir, 'dsh')
  mkdirSync(binDir, { recursive: true })
  try {
    const existing = existsSync(launcher) ? readFileSync(launcher, 'utf8') : undefined
    if (existing !== undefined && !existing.includes(marker)) return
    if (existing === script) return
    writeFileSync(launcher, `${script}\n`)
    chmodSync(launcher, 0o755)
    console.info(`Installed dsh launcher at ${launcher}`)
    if (!(process.env.PATH ?? '').includes(binDir)) {
      console.info(`Hint: add ${binDir} to PATH (echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc)`)
    }
  } catch (error) {
    // A read-only home or restricted environment never blocks the app itself.
    console.warn(`dsh launcher install skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * The headless one-shot profile in Anton's home: the product
 * `dsh --profile headless "task"` surface, provisioned beside the app's own
 * profiles so the terminal launcher and the app share one DSH_HOME.
 */
function ensureHeadlessProfile(): void {
  const profileDir = join(dshHome, 'profiles', 'headless')
  const manifestPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  mkdirSync(profileDir, { recursive: true })
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, `${JSON.stringify({
      name: 'anton-profile-headless',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
    }, null, 2)}\n`)
  }
  if (!existsSync(patchPath)) {
    const toolsMode = process.env.ANTON_TOOLS_MODE ?? 'paged'
    writeFileSync(patchPath, ['- id: tools', '  config:', `    mode: ${toolsMode}`, ''].join('\n'))
  }
}

function ensureBundledContextProfile(): void {
  if (!existsSync(bundledContextPluginRoot)) {
    throw new Error(`Bundled c0ntext plugin was not found at ${bundledContextPluginRoot}`)
  }

  ensureRecoveryProfile()
  ensureRepairProfile()
  ensureHeadlessProfile()
  ensureDshLauncher()
  const profileDir = join(dshHome, 'profiles', profile)
  const manifestPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const pluginLink = join(profileDir, 'node_modules', '@c0ntext', 'dsh-c0ntext')
  mkdirSync(dirname(pluginLink), { recursive: true })

  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, `${JSON.stringify({
      name: `anton-profile-${profile}`,
      private: true,
      dependencies: { '@c0ntext/dsh-c0ntext': `file:${bundledContextPluginRoot}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@c0ntext/dsh-c0ntext'] } },
    }, null, 2)}\n`)
  }
  if (!existsSync(patchPath)) {
    // Tool presentation is a deployment choice on the base bundle's `tools`
    // row (which ships none, keeping the native schema default). Anton defaults
    // to `paged`: the model gets a compact catalog plus `tool_search` instead
    // of every full schema on every request. ANTON_TOOLS_MODE=native restores
    // the legacy behavior. Existing profiles keep the patch they already have.
    const toolsMode = process.env.ANTON_TOOLS_MODE ?? 'paged'
    writeFileSync(patchPath, `${patchBody(toolsMode)}`)
  }
  try {
    if (lstatSync(pluginLink).isSymbolicLink()) {
      unlinkSync(pluginLink)
    } else {
      throw new Error(`Bundled profile path ${pluginLink} exists and is not a symlink`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  symlinkSync(bundledContextPluginRoot, pluginLink, 'junction')
}

async function requestHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) })
    return response.ok
  } catch {
    return false
  }
}

async function harnessRunning(): Promise<boolean> {
  return requestHealth(`${harnessUrl}/`)
}

async function waitForHarness(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await harnessRunning()) return true
    await Bun.sleep(250)
  }
  return false
}

/** Wait until the old child has stopped accepting HTTP requests before replacement. */
async function waitForHarnessStopped(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await harnessRunning())) return true
    await Bun.sleep(100)
  }
  return false
}

async function startHarness(): Promise<{ started: boolean; reused: boolean }> {
  if (await harnessRunning()) return { started: false, reused: true }
  if (harnessProcess && harnessProcess.exitCode === null) return { started: false, reused: false }

  if (!existsSync(harnessRoot)) {
    throw new Error(`DeepSeek Harness checkout was not found at ${harnessRoot}. Set ANTON_DSH_ROOT to its absolute path.`)
  }
  if (!existsSync(harnessEntry)) {
    throw new Error(`DeepSeek Harness entry was not found at ${harnessEntry}. Build the harness first (npm run build:lib:host) or set ANTON_HARNESS_ENTRY to its built CLI.`)
  }
  ensureBundledContextProfile()
  ensureBlueantPreset({ dshHome, profile, harnessRoot })
  ensureBlueantProfileLink({ dshHome, profile, harnessRoot })

  const child = Bun.spawn(
    [nodeBinary, ...(harnessLoader === '' ? [] : ['--import', harnessLoader]), harnessEntry, '--profile', profile, '--port', String(harnessPort)],
    {
      cwd: harnessRoot,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...process.env,
        ANTON_CONTEXT_ENDPOINT: contextEndpoint,
        ANTON_CONTEXT_API_KEY: resolveContextApiKey(),
        DSH_HOME: dshHome,
      },
    },
  )
  harnessProcess = child
  void child.exited.then((exitCode) => {
    if (harnessProcess === child) {
      console.info(`DeepSeek Harness exited with status ${exitCode}`)
      harnessProcess = undefined
    }
  })

  if (!(await waitForHarness())) {
    child.kill('SIGTERM')
    throw new Error('DeepSeek Harness did not become ready within 30 seconds')
  }
  return { started: true, reused: false }
}

async function stopHarness(): Promise<void> {
  if (!harnessProcess || harnessProcess.exitCode !== null) {
    if (await harnessRunning()) {
      throw new Error('Harness is running, but it was not started by this bridge. Stop it from its owning process first.')
    }
    return
  }

  const child = harnessProcess
  child.kill('SIGTERM')
  await Promise.race([child.exited, Bun.sleep(5_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
  // Process exit and socket shutdown are not observed at exactly the same
  // instant. Restart must not race the old listener and accidentally return
  // `reused`, leaving the Bridge with no managed child after the old process
  // finally exits.
  if (!(await waitForHarnessStopped())) {
    throw new Error('Harness did not stop accepting requests before restart')
  }
}

async function status() {
  const [harness, context] = await Promise.all([
    harnessRunning(),
    requestHealth(`${contextEndpoint}/health`),
  ])

  return {
    bridge: {
      status: 'ok',
      started_at: startedAt,
      url: bridgeUrl,
      listening_on: `127.0.0.1:${bridgePort}`,
    },
    harness: {
      running: harness,
      managed_by_bridge: Boolean(harnessProcess && harnessProcess.exitCode === null),
      pid: harnessProcess?.pid ?? null,
      url: harnessUrl,
      profile,
      root: harnessRoot,
      entry: harnessEntry,
    },
    context: {
      healthy: context,
      endpoint: contextEndpoint,
      configured_in: process.env.ANTON_CONTEXT_ENDPOINT === undefined ? configPath : 'ANTON_CONTEXT_ENDPOINT',
    },
  }
}

/**
 * Restart the Harness process this bridge manages. The primary deployment
 * loop for code changes: rebuild, POST here from a terminal or an agent
 * tool, and the fresh process loads the new bundles. A harness that is
 * externally managed (not started by this bridge) is refused — the owner
 * must restart it — while a stopped harness is simply started.
 */
async function restartHarness(): Promise<{ restarted: boolean; reused: boolean }> {
  const wasRunning = await harnessRunning()
  const isManaged = Boolean(harnessProcess && harnessProcess.exitCode === null)
  if (wasRunning && !isManaged) {
    throw new Error('Harness is externally managed. Restart it from its owning process.')
  }
  if (wasRunning) await stopHarness()
  await startHarness()
  return { restarted: wasRunning, reused: wasRunning }
}

/** Persist a new default endpoint and restart only the Harness process we own. */
async function configureContextEndpoint(value: unknown): Promise<{ endpoint: string; restartedHarness: boolean }> {
  if (typeof value !== 'string') throw new Error('contextEndpoint must be a string')
  const nextEndpoint = normalizeContextEndpoint(value)
  const harnessWasRunning = await harnessRunning()
  const harnessIsManaged = Boolean(harnessProcess && harnessProcess.exitCode === null)
  if (harnessWasRunning && !harnessIsManaged) {
    throw new Error('Harness is externally managed. Stop it first, then change the c0ntext endpoint.')
  }

  contextEndpoint = nextEndpoint
  writeBridgeConfig({ contextEndpoint })
  if (!harnessWasRunning) return { endpoint: contextEndpoint, restartedHarness: false }

  await stopHarness()
  await startHarness()
  return { endpoint: contextEndpoint, restartedHarness: true }
}

function json(payload: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('cache-control', 'no-store')
  return Response.json(payload, { ...init, headers })
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  return origin === null || origin === new URL(request.url).origin
}

/**
 * Loopback control requests without a browser behind them: curl and agent
 * tool calls send no Origin header, so the browser-CSRF fence must not
 * apply — there is no victim site to forge from. Any PRESENT Origin still
 * has to match, keeping every browser path exactly as fenced as before.
 */
function loopbackControlAllowed(request: Request): boolean {
  return request.headers.get('origin') === null && sameOrigin(request)
}

function allowedHost(request: Request): boolean {
  const hostname = new URL(request.url).hostname
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === 'antoncode.localhost'
}

function controlPage(): Response {
  return new Response(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anton Bridge</title>
<style>body{font:16px system-ui,sans-serif;background:#10141d;color:#e9edf5;margin:0;padding:3rem;max-width:56rem}h1{margin-top:0}code{background:#1b2330;padding:.18rem .35rem;border-radius:.25rem}button,a{display:inline-block;background:#7c5cff;color:#fff;border:0;border-radius:.4rem;padding:.65rem .9rem;margin:.25rem .4rem .25rem 0;font:inherit;text-decoration:none;cursor:pointer}button.secondary{background:#334155}pre{background:#151b25;padding:1rem;border-radius:.5rem;overflow:auto}.bad{color:#ff9b9b}.good{color:#9ce6b0}</style>
<h1>Anton Bridge</h1><p>Local control plane for DeepSeek Harness.</p>
<p><a href="/">Open Harness</a><button id="start">Start Harness</button><button class="secondary" id="stop">Stop Harness</button></p>
<p><label>c0ntext endpoint <input id="endpoint" type="url" size="42" placeholder="http://127.0.0.1:8090"></label> <button class="secondary" id="saveEndpoint">Apply endpoint</button></p>
<pre id="status">Loading status…</pre>
<script>
const status = document.querySelector('#status');
const endpoint = document.querySelector('#endpoint');
async function refresh(){const r=await fetch('/bridge/api/status'); const s=await r.json(); status.textContent=JSON.stringify(s,null,2); endpoint.value=s.context.endpoint;}
async function action(path){const r=await fetch(path,{method:'POST'}); const body=await r.json(); if(!r.ok) alert(body.error || 'Request failed'); await refresh();}
document.querySelector('#start').onclick=()=>action('/bridge/api/harness/start');
document.querySelector('#stop').onclick=()=>action('/bridge/api/harness/stop');
document.querySelector('#saveEndpoint').onclick=async()=>{const r=await fetch('/bridge/api/context/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contextEndpoint:endpoint.value})});const body=await r.json();if(!r.ok)alert(body.error||'Request failed');await refresh();};
refresh(); setInterval(refresh,3000);
</script></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

async function proxyHarness(request: Request): Promise<Response> {
  try {
    const requestUrl = new URL(request.url)
    const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, harnessUrl)
    const headers = new Headers(request.headers)
    headers.delete('host')
    headers.delete('connection')
    // Harness deliberately fences its local API to same-origin browser calls.
    // The bridge is the trusted loopback boundary, so translate its public
    // origin back to the private upstream origin rather than leaking the
    // browser-facing hostname to Harness.
    if (headers.has('origin')) headers.set('origin', harnessUrl)
    const referer = headers.get('referer')
    if (referer !== null) {
      try {
        const refererUrl = new URL(referer)
        headers.set('referer', new URL(`${refererUrl.pathname}${refererUrl.search}`, harnessUrl).href)
      } catch {
        headers.delete('referer')
      }
    }
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    })
    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete('connection')
    return new Response(response.body, { status: response.status, headers: responseHeaders })
  } catch {
    return new Response('DeepSeek Harness is unavailable. Open /bridge and start it.', { status: 503 })
  }
}

function isDownlink(pathname: string): pathname is Downlink {
  return pathname === '/api/events.mux' || pathname === '/api/events.host'
}

function relayDownlink(socket: Bun.ServerWebSocket<BridgeSocketData>): void {
  const target = new URL(socket.data.downlink, harnessWebSocketUrl)
  // DeepSeek Harness accepts downlinks only from the same trusted loopback
  // authority. The browser sees antoncode.localhost, while this relay safely
  // establishes the corresponding private connection to Harness.
  const upstream = new WebSocket(target, { headers: { origin: harnessUrl } })
  socket.data.upstream = upstream

  upstream.addEventListener('message', (event) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(event.data)
  })
  upstream.addEventListener('close', (event) => {
    if (socket.readyState === WebSocket.OPEN) socket.close(event.code || 1000, event.reason)
  })
  upstream.addEventListener('error', () => {
    if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'Harness event stream unavailable')
  })
}

const server = Bun.serve<BridgeSocketData>({
  hostname: '127.0.0.1',
  port: bridgePort,
  // Harness keeps its event downlinks open for the lifetime of a page.
  idleTimeout: 255,
  async fetch(request, server) {
    if (!allowedHost(request)) return new Response('Not found', { status: 404 })
    const { pathname } = new URL(request.url)

    if (isDownlink(pathname)) {
      if (!sameOrigin(request)) return new Response('cross-origin request rejected', { status: 403 })
      if (server.upgrade(request, { data: { downlink: pathname } })) return undefined
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    if (pathname === '/bridge' || pathname === '/bridge/') return controlPage()
    if (pathname === '/bridge/api/status' && request.method === 'GET') return json(await status())
    if (pathname === '/bridge/api/recovery/state' && request.method === 'GET') {
      if (!sameOrigin(request)) return json({ error: 'cross_origin_request_rejected' }, { status: 403 })
      return json({ profile, repair: repairStatus })
    }

    if (pathname === '/bridge/api/context/config' && request.method === 'POST') {
      if (!sameOrigin(request)) return json({ error: 'cross_origin_request_rejected' }, { status: 403 })
      try {
        const payload: unknown = await request.json()
        const contextEndpoint = typeof payload === 'object' && payload !== null
          ? (payload as { contextEndpoint?: unknown }).contextEndpoint
          : undefined
        return json({ ...(await configureContextEndpoint(contextEndpoint)), status: await status() })
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'unable_to_configure_context_endpoint' }, { status: 400 })
      }
    }

    if (pathname === '/bridge/api/harness/start' && request.method === 'POST') {
      // Lifecycle controls accept origin-less loopback callers (curl, agent
      // tools); a browser-supplied Origin must still match exactly.
      if (!sameOrigin(request)) return json({ error: 'cross_origin_request_rejected' }, { status: 403 })
      try {
        return json({ ...(await startHarness()), status: await status() })
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'unable_to_start_harness' }, { status: 503 })
      }
    }

    if (pathname === '/bridge/api/harness/restart' && request.method === 'POST') {
      if (!loopbackControlAllowed(request)) return json({ error: 'cross_origin_request_rejected' }, { status: 403 })
      try {
        return json({ ...(await restartHarness()), status: await status() })
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'unable_to_restart_harness' }, { status: 503 })
      }
    }

    if (pathname === '/bridge/api/harness/stop' && request.method === 'POST') {
      if (!sameOrigin(request)) return json({ error: 'cross_origin_request_rejected' }, { status: 403 })
      try {
        await stopHarness()
        return json({ stopped: true, status: await status() })
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'unable_to_stop_harness' }, { status: 409 })
      }
    }

    if (pathname === '/bridge/api/notify' && request.method === 'POST') {
      // Act tier inbox: any loopback caller (the blueant_notify tool) may
      // enqueue a notification; the Mac app polls, delivers it through
      // UNUserNotificationCenter, and acks. Queue is small and bounded so a
      // chatty agent cannot flood the notification center.
      if (!loopbackControlAllowed(request)) return json({ error: 'cross_origin_request_rejected' }, { status: 403 })
      try {
        const payload: unknown = await request.json()
        const body = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
        const text = typeof body.body === 'string' ? body.body.slice(0, 2000) : ''
        if (text === '') return json({ error: 'body_required' }, { status: 400 })
        const title = typeof body.title === 'string' && body.title !== '' ? body.title.slice(0, 200) : 'Blueant'
        const id = `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        pendingNotifications.push({ id, title, body: text })
        if (pendingNotifications.length > 20) pendingNotifications.splice(0, pendingNotifications.length - 20)
        return json({ id, queued: true })
      } catch {
        return json({ error: 'invalid_json' }, { status: 400 })
      }
    }

    if (pathname === '/bridge/api/notify/pending' && request.method === 'GET') {
      return json({ notifications: pendingNotifications })
    }

    if (pathname === '/bridge/api/notify/ack' && request.method === 'POST') {
      if (!loopbackControlAllowed(request)) return json({ error: 'cross_origin_request_rejected' }, { status: 403 })
      try {
        const payload: unknown = await request.json()
        const ids = typeof payload === 'object' && payload !== null && Array.isArray((payload as { ids?: unknown }).ids)
          ? (payload as { ids: unknown[] }).ids.filter((id): id is string => typeof id === 'string')
          : []
        const idSet = new Set(ids)
        for (let i = pendingNotifications.length - 1; i >= 0; i -= 1) {
          if (idSet.has(pendingNotifications[i].id)) pendingNotifications.splice(i, 1)
        }
        return json({ acked: ids.length })
      } catch {
        return json({ error: 'invalid_json' }, { status: 400 })
      }
    }

    if (pathname === '/bridge/api/propose' && request.method === 'POST') {
      // Act tier: propose-then-approve. The blueant_propose tool enqueues a
      // shell command; the Mac app surfaces an Approve/Run panel; the
      // decision (and, when approved, the command output) lands in
      // proposalDecisions for the tool to poll.
      if (!loopbackControlAllowed(request)) return json({ error: 'cross_origin_request_rejected' }, { status: 403 })
      try {
        const payload: unknown = await request.json()
        const body = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
        const command = typeof body.command === 'string' ? body.command.trim().slice(0, 4000) : ''
        if (command === '') return json({ error: 'command_required' }, { status: 400 })
        const id = `propose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        proposalDecisions.set(id, { state: 'pending', command })
        pendingNotifications.push({ id, kind: 'proposal', title: 'Blueant wants to run a command', body: command })
        if (pendingNotifications.length > 20) pendingNotifications.splice(0, pendingNotifications.length - 20)
        return json({ id, queued: true })
      } catch {
        return json({ error: 'invalid_json' }, { status: 400 })
      }
    }

    if (pathname === '/bridge/api/propose/decide' && request.method === 'POST') {
      if (!loopbackControlAllowed(request)) return json({ error: 'cross_origin_request_rejected' }, { status: 403 })
      try {
        const payload: unknown = await request.json()
        const body = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
        const id = typeof body.id === 'string' ? body.id : ''
        const proposal = id === '' ? undefined : proposalDecisions.get(id)
        if (proposal === undefined) return json({ error: 'unknown_proposal' }, { status: 404 })
        if (proposal.state !== 'pending') return json({ id, ...proposal })
        const approved = body.approved === true
        if (!approved) {
          proposal.state = 'denied'
          return json({ id, state: 'denied' })
        }
        // Approved: run in the Blueant workspace, bounded — 30s wall clock,
        // 10 KB of combined output. The human gate is the click that got us
        // here; this execution is the action that click approved.
        proposal.state = 'approved'
        const proc = Bun.spawn(['bash', '-c', proposal.command], {
          cwd: blueantWorkspacePath(),
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const timer = setTimeout(() => proc.kill(), 30_000)
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ])
        const stderr = await new Response(proc.stderr).text()
        clearTimeout(timer)
        proposal.exitCode = exitCode
        proposal.output = `${stdout}\n${stderr}`.trim().slice(0, 10_000)
        return json({ id, state: 'approved', exitCode, output: proposal.output })
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'decision_failed' }, { status: 500 })
      }
    }

    if (pathname === '/bridge/api/propose/decision' && request.method === 'GET') {
      const id = new URL(request.url).searchParams.get('id') ?? ''
      const proposal = id === '' ? undefined : proposalDecisions.get(id)
      if (proposal === undefined) return json({ error: 'unknown_proposal' }, { status: 404 })
      return json({ id, ...proposal })
    }

    return proxyHarness(request)
  },
  websocket: {
    idleTimeout: 255,
    open: relayDownlink,
    // DSH's event connections are explicitly downlink-only. The HTTP API
    // carries every request and response, so browser messages are rejected.
    message(socket) {
      socket.close(1008, 'downlink only')
    },
    close(socket) {
      const upstream = socket.data.upstream
      if (upstream && (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN)) {
        upstream.close()
      }
    },
  },
})

console.info(`Anton Bridge listening at ${bridgeUrl}`)
console.info(`Local controls: ${bridgeUrl}/bridge`)

/**
 * Act-tier notification inbox: blueant_notify enqueues here, the Mac app
 * polls /bridge/api/notify/pending, delivers through UNUserNotificationCenter,
 * and acks by id. Bounded — see the route handlers above.
 */
interface PendingNotification { id: string; kind?: 'proposal'; title: string; body: string }
const pendingNotifications: PendingNotification[] = []

/**
 * Propose-then-approve ledger: blueant_propose enqueues a command, the Mac
 * app's Approve/Run panel posts the decision, approved commands execute here
 * (bounded), and the tool polls the verdict. Entries live for the process
 * lifetime — proposals are single-ask, not a durable queue.
 */
interface ProposalDecision {
  state: 'pending' | 'approved' | 'denied'
  command: string
  exitCode?: number
  output?: string
}
const proposalDecisions = new Map<string, ProposalDecision>()

/// The Blueant agent workspace: approved commands run here, not in the
/// harness checkout.
function blueantWorkspacePath(): string {
  const support = process.env.HOME ?? ''
  return `${support}/Library/Application Support/Anton/blueant`
}

/**
 * The automatic repair turn, driven only while the recovery profile carries
 * the surface. One bounded one-shot agent run per recovery entry: diagnose
 * the recorded boot failure, fix the source checkout, rebuild, and swap the
 * app bundle in place. Output lands in bridge.log beside the failure it
 * answers. ANTON_AUTO_REPAIR=false disables the run; the recovery web UI
 * stays available for manual repair either way.
 */
let repairStatus: 'off' | 'running' | 'done' | 'failed' = 'off'
let repairProcess: Bun.Subprocess | undefined

function launchRepairRun(): void {
  if (repairProcess !== undefined || repairStatus === 'running') return
  // Source checkout: the app bundle sits at <repo>/dist/Anton.app, so the
  // repo root is three levels above the bundled harness tree.
  const sourceRoot = resolve(harnessRoot, '..', '..', '..')
  const task = [
    'Anton crashed out of its main profile and is running in recovery mode; you are its built-in repair agent.',
    `1. Read the last 300 lines of ${join(homedir(), 'Library', 'Application Support', 'Anton', 'bridge.log')} and identify the harness boot failure (loader entry, plugin error, or missing file).`,
    `2. Fix the root cause in the source checkout${existsSync(join(sourceRoot, 'package.json')) ? ` at ${sourceRoot}` : ''} — the failing plugin may live in the main repo or a sibling checkout (mail-plugin, c0ntext/deepseek-harness-plugin). Keep changes minimal.`,
    '3. Rebuild what you changed (pnpm run build in the changed checkout), then rebuild and swap the app in place: cd to the deepseek-harness repo and run ANTON_IN_PLACE_SWAP=1 pnpm run anton:build:macos.',
    `4. Write a short diagnosis and outcome to ${join(homedir(), 'Library', 'Application Support', 'Anton', 'repair-result.md')}.`,
    'If the failure is beyond a code fix, write the diagnosis and stop.',
  ].join('\n')
  repairStatus = 'running'
  console.info('Recovery: starting automatic repair turn')
  const child = Bun.spawn([nodeBinary, harnessEntry, '--profile', 'repair', task], {
    cwd: harnessRoot,
    stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
    env: {
      ...process.env,
      ANTON_CONTEXT_ENDPOINT: contextEndpoint,
      ANTON_CONTEXT_API_KEY: resolveContextApiKey(),
      DSH_HOME: dshHome,
    },
  })
  repairProcess = child
  void child.exited.then((exitCode) => {
    repairProcess = undefined
    repairStatus = exitCode === 0 ? 'done' : 'failed'
    console.info(`Recovery: repair turn exited with status ${exitCode} (${repairStatus})`)
  })
}

if (autoStart) {
  void startHarness().then((result) => {
    console.info(result.reused ? 'Using an already-running DeepSeek Harness instance' : 'DeepSeek Harness started by Anton Bridge')
    if (profile === 'recovery' && process.env.ANTON_AUTO_REPAIR !== 'false') launchRepairRun()
  }).catch(error => console.error(error))
}

async function shutdown(signal: string): Promise<void> {
  console.info(`Received ${signal}; stopping Anton Bridge`)
  server.stop(true)
  try {
    await stopHarness()
  } catch (error) {
    console.warn(error instanceof Error ? error.message : error)
  }
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
