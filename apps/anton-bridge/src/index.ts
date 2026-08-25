import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const bridgePort = portFromEnv('ANTON_BRIDGE_PORT', 3742)
const harnessPort = portFromEnv('ANTON_HARNESS_PORT', 3080)
const profile = process.env.ANTON_DSH_PROFILE ?? 'web'
const nodeBinary = process.env.ANTON_NODE_BINARY ?? 'node'
// The harness ships as built JavaScript (apps/cli/lib/bin.js), not source:
// no import loader is needed. A deployment that runs from source sets
// ANTON_HARNESS_LOADER=tsx/esm and points ANTON_HARNESS_ENTRY at src/bin.ts.
const harnessLoader = process.env.ANTON_HARNESS_LOADER ?? ''
const dockerBinary = process.env.ANTON_DOCKER_BINARY ?? 'docker'
const autoStartContext = process.env.ANTON_CONTEXT_AUTO_START === 'true'
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

function defaultContextRoot(): string {
  return firstDefined(
    [
      process.env.ANTON_CONTEXT_ROOT,
      resolve(harnessRoot, '..', 'c0ntext'),
      resolve(process.cwd(), '..', 'c0ntext'),
      resolve(process.cwd(), 'c0ntext'),
    ].filter((candidate): candidate is string => Boolean(candidate)),
    candidate => existsSync(join(candidate, 'docker-compose.yml')),
  )
}

const contextRoot = defaultContextRoot()
// Development and the packaged app use the same profile assembly. The app
// supplies Application Support paths; checkout development gets ~/.anton/dsh
// so it cannot accidentally mutate a developer's ordinary ~/.dsh profile.
const dshHome = process.env.ANTON_DSH_HOME ?? join(homedir(), '.anton', 'dsh')
const bundledContextPluginRoot = process.env.ANTON_CONTEXT_PLUGIN_ROOT
  ?? join(contextRoot, 'deepseek-harness-plugin')

/**
 * The Anton profile patch body: the deployment overlay this app writes on
 * first launch (existing profiles keep whatever patch they already have).
 *
 * Context policy is eviction-first. Eviction is cheap, deterministic, and
 * reversible — evicted ranges stay mirrored in the engine and come back
 * through bitemporal search — while LLM compaction is expensive and freezes a
 * summary of a problem that has often already moved on by the time pressure
 * accumulates. So the c0ntext evictor owns working-set reduction at a fraction
 * of the window far below any summarization threshold, and proactive
 * compaction is switched off: only the reactive overflow recovery and manual
 * `/compact` remain, and both route their one-shot summarizer to a free
 * OpenCode model instead of the conversation's own paid route.
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
    '    projectId: c0ntext',
    '    tokenBudget: 1200',
    '    requestedZones: [goal, constraints, active_plan, active_tabs, focus_artifact, findings, next_actions, project_decisions, project_facts, project_investigations, episodes, investigations, agent_cases, hypotheses]',
    '    mirrorSession: true',
    '    # Human-memory policy: evict before the surface reaches 40% of the',
    '    # declared window (research threshold where model intelligence starts',
    '    # degrading on long contexts). Sweeps batch down to the 60% watermark',
    '    # so eviction runs rarely, in large contiguous pages, not one node at a',
    '    # time. Evicted ranges are mirrored into the engine first; bitemporal',
    '    # search resuscitates them when a later query needs them.',
    '    maxSurfaceRatio: 0.60',
    '    retainTokens: 4000',    '    evictorEnabled: true',
    '    searchToolEnabled: true',
    '    imageFallbackEnabled: true',
    '    visionProvider: kimi-coding',
    '    visionModel: k3',
    '    visionMaxTokens: 1200',
    "    # Evicted pages are archived to the engine's POST /pages/archive, which",
    '    # owns all corpus-level topic intelligence upstream. Any LLM word-cloud',
    '    # enrichment is ENGINE config (c0ntext gateway/worker), never plugin',
    '    # config — this row stays a thin mirror/evict/search shim.',
    '    # Compaction stays mounted as an armed safety net, not a policy: the',
    '    # evictor caps the working set far below its 80% threshold, so its',
    '    # proactive path is unreachable while eviction is healthy — but keeping',
    '    # it automatic preserves provider-overflow recovery if the evictor ever',
    '    # cannot keep up. Both remaining paths summarize through the free',
    "    # OpenCode tier instead of the conversation's own paid route.",
    '- id: compaction-basic',
    '  config:',
    '    summarizationProvider: opencode-free',
    '    summarizationModel: nemotron-3.5-lightning-free',
    '',
  ].join('\n')
}

function ensureBundledContextProfile(): void {
  if (!existsSync(bundledContextPluginRoot)) {
    throw new Error(`Bundled c0ntext plugin was not found at ${bundledContextPluginRoot}`)
  }

  const profileDir = join(dshHome, 'profiles', profile)
  const manifestPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const pluginLink = join(profileDir, 'node_modules', '@c0ntext', 'dsh-context')
  mkdirSync(dirname(pluginLink), { recursive: true })

  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, `${JSON.stringify({
      name: `anton-profile-${profile}`,
      private: true,
      dependencies: { '@c0ntext/dsh-context': `file:${bundledContextPluginRoot}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@c0ntext/dsh-context'] } },
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

async function waitForContext(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await requestHealth(`${contextEndpoint}/health`)) return true
    await Bun.sleep(500)
  }
  return false
}

async function runCompose(args: string[]): Promise<void> {
  if (!existsSync(join(contextRoot, 'docker-compose.yml'))) {
    throw new Error(`c0ntext compose source was not found at ${contextRoot}`)
  }
  const child = Bun.spawn([dockerBinary, 'compose', ...args], { cwd: contextRoot, stdout: 'pipe', stderr: 'pipe' })
  const exitCode = await child.exited
  if (exitCode === 0) return
  const stderr = await new Response(child.stderr).text()
  throw new Error(stderr.trim() || `${dockerBinary} compose ${args.join(' ')} failed with status ${exitCode}`)
}

async function startContext(): Promise<{ started: boolean; reused: boolean }> {
  if (await requestHealth(`${contextEndpoint}/health`)) return { started: false, reused: true }
  await runCompose(['up', '-d'])
  if (!(await waitForContext())) throw new Error('c0ntext did not become healthy within 60 seconds')
  return { started: true, reused: false }
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

  const child = Bun.spawn(
    [nodeBinary, ...(harnessLoader === '' ? [] : ['--import', harnessLoader]), harnessEntry, '--profile', profile, '--port', String(harnessPort)],
    {
      cwd: harnessRoot,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...process.env, ANTON_CONTEXT_ENDPOINT: contextEndpoint, DSH_HOME: dshHome },
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
      root: contextRoot,
      docker_command: dockerBinary,
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
<h1>Anton Bridge</h1><p>Local control plane for DeepSeek Harness and c0ntext.</p>
<p><a href="/">Open Harness</a><button id="start">Start Harness</button><button class="secondary" id="stop">Stop Harness</button><button class="secondary" id="startContext">Start local c0ntext</button></p>
<p><label>c0ntext endpoint <input id="endpoint" type="url" size="42" placeholder="http://127.0.0.1:8090"></label> <button class="secondary" id="saveEndpoint">Apply endpoint</button></p>
<pre id="status">Loading status…</pre>
<script>
const status = document.querySelector('#status');
const endpoint = document.querySelector('#endpoint');
async function refresh(){const r=await fetch('/bridge/api/status'); const s=await r.json(); status.textContent=JSON.stringify(s,null,2); endpoint.value=s.context.endpoint;}
async function action(path){const r=await fetch(path,{method:'POST'}); const body=await r.json(); if(!r.ok) alert(body.error || 'Request failed'); await refresh();}
document.querySelector('#start').onclick=()=>action('/bridge/api/harness/start');
document.querySelector('#stop').onclick=()=>action('/bridge/api/harness/stop');
document.querySelector('#startContext').onclick=()=>action('/bridge/api/context/start');
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

    if (pathname === '/bridge/api/context/start' && request.method === 'POST') {
      if (!sameOrigin(request)) return json({ error: 'cross_origin_request_rejected' }, { status: 403 })
      try {
        return json({ ...(await startContext()), status: await status() })
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'unable_to_start_context' }, { status: 503 })
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

if (autoStart) {
  void startHarness().then((result) => {
    console.info(result.reused ? 'Using an already-running DeepSeek Harness instance' : 'DeepSeek Harness started by Anton Bridge')
  }).catch(error => console.error(error))
}

if (autoStartContext) {
  void startContext().then((result) => {
    console.info(result.reused ? 'Using an already-running c0ntext engine' : 'c0ntext started by Anton Bridge')
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
