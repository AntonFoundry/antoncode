import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

export type RebuildPhase = 'starting' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled'

export interface RebuildState {
  jobId: string
  label: string
  phase: RebuildPhase
  checkout: string
  command: string[]
  logPath: string
  plistPath: string
  supervisorPid?: number
  childProcessGroupId?: number
  startedAt: string
  deadlineAt: string
  endedAt?: string
  exitCode?: number | null
  notificationPending: boolean
  detail?: string
}

interface StartOptions {
  timeoutMinutes: number
  checkout: string
}

const TERMINAL = new Set<RebuildPhase>(['succeeded', 'failed', 'timed_out', 'cancelled'])
const DEFAULT_TIMEOUT_MINUTES = 20
const MIN_TIMEOUT_MINUTES = 2
const MAX_TIMEOUT_MINUTES = 120

function rebuildDirectory(): string {
  return process.env.ANTON_REBUILD_DIR ?? join(homedir(), 'Library', 'Application Support', 'Anton', 'rebuild')
}

function statePath(): string {
  return join(rebuildDirectory(), 'current.json')
}

function atomicWrite(state: RebuildState): void {
  mkdirSync(rebuildDirectory(), { recursive: true })
  const temporary = `${statePath()}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, statePath())
}

export function readRebuildState(): RebuildState | undefined {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as RebuildState
  } catch {
    return undefined
  }
}

function launchDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`
}

interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
}

function launchctl(...args: string[]): CommandResult {
  const result = spawnSync(process.env.ANTON_LAUNCHCTL_PATH ?? '/bin/launchctl', args, { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function launchJobAlive(state: RebuildState): boolean {
  const result = launchctl('print', `${launchDomain()}/${state.label}`)
  if (result.status !== 0) return false
  if (state.supervisorPid === undefined) return true
  return new RegExp(`\\bpid = ${state.supervisorPid}\\b`).test(result.stdout)
}

async function notify(state: RebuildState): Promise<boolean> {
  const title = state.phase === 'succeeded' ? 'Anton rebuild completed' : `Anton rebuild ${state.phase.replace('_', ' ')}`
  const body = state.phase === 'succeeded'
    ? `Installed and verified Anton. Log: ${state.logPath}`
    : `${state.detail ?? `Exit code: ${String(state.exitCode)}`} Log: ${state.logPath}`
  try {
    const response = await fetch(process.env.ANTON_REBUILD_NOTIFY_URL ?? 'http://127.0.0.1:3742/bridge/api/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, body }),
      signal: AbortSignal.timeout(2_000),
    })
    return response.ok
  } catch {
    return false
  }
}

async function retryPendingNotification(state: RebuildState): Promise<RebuildState> {
  if (!state.notificationPending || !TERMINAL.has(state.phase)) return state
  if (await notify(state)) {
    state.notificationPending = false
    atomicWrite(state)
  }
  return state
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function plist(label: string, args: string[], logPath: string): string {
  const argumentsXml = args.map(value => `    <string>${xml(value)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>
${argumentsXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>
`
}

function supervisorArguments(jobId: string): string[] {
  const entry = process.argv[1]
  if (entry === undefined) throw new Error('unable to resolve the dsh entry script')
  return [process.execPath, ...process.execArgv, resolve(entry), 'anton-rebuild-supervise', '--job', jobId]
}

// oxlint-disable-next-line typescript/require-await -- keeps the CLI dispatch's uniform Promise<number> contract
export async function startRebuild(options: StartOptions): Promise<number> {
  const timeoutMinutes = Math.trunc(options.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES)
  if (timeoutMinutes < MIN_TIMEOUT_MINUTES || timeoutMinutes > MAX_TIMEOUT_MINUTES) {
    console.error(`anton rebuild: --timeout must be ${MIN_TIMEOUT_MINUTES}-${MAX_TIMEOUT_MINUTES} minutes`)
    return 1
  }
  const checkout = resolve(options.checkout)
  if (!existsSync(join(checkout, 'scripts', 'build-anton-macos.ts'))) {
    console.error(`anton rebuild: not a DeepSeek Harness checkout: ${checkout}`)
    return 1
  }
  const existing = readRebuildState()
  if (existing !== undefined && !TERMINAL.has(existing.phase)) {
    if (launchJobAlive(existing)) {
      console.error(`anton rebuild: job ${existing.jobId} is already ${existing.phase} (log: ${existing.logPath})`)
      return 1
    }
    existing.phase = 'failed'
    existing.endedAt = new Date().toISOString()
    existing.detail = 'supervisor disappeared before recording completion'
    existing.notificationPending = true
    atomicWrite(existing)
  }
  if (existing !== undefined && TERMINAL.has(existing.phase)) {
    launchctl('bootout', `${launchDomain()}/${existing.label}`)
  }
  const started = new Date()
  const jobId = `${started.toISOString().replaceAll(/[-:.TZ]/g, '')}-${process.pid}`
  const label = `dev.antoncode.rebuild.${jobId}`
  const directory = rebuildDirectory()
  const logPath = join(directory, `${jobId}.log`)
  const plistPath = join(directory, `${jobId}.plist`)
  mkdirSync(directory, { recursive: true })
  const state: RebuildState = {
    jobId,
    label,
    phase: 'starting',
    checkout,
    command: ['pnpm', 'run', 'anton:build:macos'],
    logPath,
    plistPath,
    startedAt: started.toISOString(),
    deadlineAt: new Date(started.getTime() + timeoutMinutes * 60_000).toISOString(),
    notificationPending: false,
  }
  atomicWrite(state)
  writeFileSync(plistPath, plist(label, supervisorArguments(jobId), logPath), 'utf8')
  const result = launchctl('bootstrap', launchDomain(), plistPath)
  if (result.status !== 0) {
    state.phase = 'failed'
    state.endedAt = new Date().toISOString()
    state.detail = `launchctl bootstrap failed: ${result.stderr.trim()}`
    state.notificationPending = true
    atomicWrite(state)
    console.error(`anton rebuild: ${state.detail}`)
    return 1
  }
  console.log(JSON.stringify(state, null, 2))
  return 0
}

export async function rebuildStatus(): Promise<number> {
  let state = readRebuildState()
  if (state === undefined) {
    console.log(JSON.stringify({ phase: 'idle' }, null, 2))
    return 0
  }
  if (!TERMINAL.has(state.phase) && !launchJobAlive(state)) {
    state.phase = 'failed'
    state.endedAt = new Date().toISOString()
    state.detail = 'supervisor is no longer registered with launchd'
    state.notificationPending = true
    atomicWrite(state)
  }
  state = await retryPendingNotification(state)
  console.log(JSON.stringify(state, null, 2))
  return state.phase === 'failed' || state.phase === 'timed_out' ? 1 : 0
}

// oxlint-disable-next-line typescript/require-await -- keeps the CLI dispatch's uniform Promise<number> contract
export async function cancelRebuild(): Promise<number> {
  const state = readRebuildState()
  if (state === undefined || TERMINAL.has(state.phase)) {
    console.error('anton rebuild: no active rebuild')
    return 1
  }
  if (!launchJobAlive(state)) {
    state.phase = 'failed'
    state.endedAt = new Date().toISOString()
    state.detail = 'supervisor disappeared before cancellation'
    state.notificationPending = true
    atomicWrite(state)
    console.error(`anton rebuild: ${state.detail}`)
    return 1
  }
  const result = launchctl('kill', 'SIGTERM', `${launchDomain()}/${state.label}`)
  if (result.status !== 0) {
    console.error(`anton rebuild: cancel failed: ${result.stderr.trim()}`)
    return 1
  }
  console.log(JSON.stringify({ jobId: state.jobId, cancellationRequested: true, logPath: state.logPath }, null, 2))
  return 0
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ESRCH') throw error
  }
}

export async function superviseRebuild(jobId: string): Promise<number> {
  const state = readRebuildState()
  if (state === undefined || state.jobId !== jobId || state.phase !== 'starting') return 2
  state.supervisorPid = process.pid
  state.phase = 'running'
  atomicWrite(state)
  const log = openSync(state.logPath, 'a')
  const command = state.command[0]
  if (command === undefined) throw new Error('rebuild command is empty')
  const child = spawn(command, state.command.slice(1), {
    cwd: state.checkout,
    detached: true,
    env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}` },
    stdio: ['ignore', log, log] as const,
  })
  if (child.pid === undefined) {
    closeSync(log)
    state.phase = 'failed'
    state.endedAt = new Date().toISOString()
    state.detail = 'build process did not start'
    state.notificationPending = true
    atomicWrite(state)
    return 1
  }
  const childPid = child.pid
  state.childProcessGroupId = childPid
  atomicWrite(state)
  let requested: 'cancelled' | 'timed_out' | undefined
  let killTimer: NodeJS.Timeout | undefined
  const terminate = (reason: 'cancelled' | 'timed_out'): void => {
    if (requested !== undefined) return
    requested = reason
    signalProcessGroup(childPid, 'SIGTERM')
    killTimer = setTimeout(() => { signalProcessGroup(childPid, 'SIGKILL') }, 8_000)
  }
  process.on('SIGTERM', () => { terminate('cancelled') })
  process.on('SIGINT', () => { terminate('cancelled') })
  const timeoutMs = Math.max(0, new Date(state.deadlineAt).getTime() - Date.now())
  const deadlineTimer = setTimeout(() => { terminate('timed_out') }, timeoutMs)
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => { resolveExit({ code, signal }) })
  }).catch((error: unknown) => ({ code: 1, signal: null, error }))
  clearTimeout(deadlineTimer)
  if (killTimer !== undefined) clearTimeout(killTimer)
  closeSync(log)
  state.endedAt = new Date().toISOString()
  state.exitCode = exit.code
  if (requested !== undefined) {
    state.phase = requested
    state.detail = requested === 'timed_out' ? 'build exceeded its deadline' : 'cancelled by user'
  } else if (exit.code === 0) {
    state.phase = 'succeeded'
  } else {
    state.phase = 'failed'
    state.detail = `build exited with ${exit.code === null ? `signal ${String(exit.signal)}` : `code ${exit.code}`}`
  }
  state.notificationPending = true
  atomicWrite(state)
  // The bridge is down for exactly the window a rebuild quits the app, so
  // delivery retries outlive the relaunch. ANTON_REBUILD_NOTIFY_ATTEMPTS
  // bounds the loop for tests; production keeps the full window.
  const attemptCap = Math.max(1, Math.trunc(Number(process.env.ANTON_REBUILD_NOTIFY_ATTEMPTS ?? 45)) || 45)
  for (let attempt = 0; attempt < attemptCap; attempt += 1) {
    if (await notify(state)) {
      state.notificationPending = false
      atomicWrite(state)
      break
    }
    if (attempt + 1 < attemptCap) await new Promise((resolveWait) => { setTimeout(resolveWait, 2_000) })
  }
  return state.phase === 'succeeded' ? 0 : 1
}

export function resetRebuildStateForTest(): void {
  try { unlinkSync(statePath()) } catch {}
}
