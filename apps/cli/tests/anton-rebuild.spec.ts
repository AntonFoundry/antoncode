import { afterAll, beforeEach, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'

import {
  cancelRebuild,
  readRebuildState,
  rebuildStatus,
  resetRebuildStateForTest,
  startRebuild,
  superviseRebuild,
  type RebuildState,
} from '../src/anton-rebuild.ts'

/**
 * Supervisor tests run the real `superviseRebuild` loop against real child
 * processes (`node -e`), a fake `launchctl` script, and an ephemeral notify
 * server — the launchd GUI domain and the live bridge stay untouched.
 */

let directory: string
let notifyServer: Server
let notifyPort = 0
/** Status codes the notify server hands out, in order; the last one repeats. */
let notifyStatuses: number[] = []
const notifyBodies: { title: string; body: string }[] = []
const previousEnv: Record<string, string | undefined> = {}

function setEnv(name: string, value: string | undefined): void {
  if (!(name in previousEnv)) previousEnv[name] = process.env[name]
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

/**
 * A launchctl stand-in that records every invocation. `print` reports the
 * given pid as the running job when `printAlive`, or fails (label gone);
 * every other command succeeds.
 */
function writeFakeLaunchctl(printAlive: boolean, pid = 4242): string {
  const path = join(directory, 'launchctl-fake')
  writeFileSync(path, `#!/bin/sh
echo "$*" >> "$0.log"
if [ "$1" = "print" ]; then
  ${printAlive ? `echo "pid = ${pid}"` : 'exit 1'}
fi
exit 0
`, { encoding: 'utf8', mode: 0o755 })
  return path
}

function launchctlLog(): string[] {
  try {
    return readFileSync(`${process.env.ANTON_LAUNCHCTL_PATH}.log`, 'utf8').trim().split('\n').filter(line => line.length > 0)
  } catch {
    return []
  }
}

/** A nonterminal state shaped like `startRebuild` writes it. */
function seedState(overrides: Partial<RebuildState>): RebuildState {
  const started = new Date()
  const state: RebuildState = {
    jobId: `job-${Math.random().toString(36).slice(2, 8)}`,
    label: 'dev.antoncode.rebuild.job',
    phase: 'starting',
    checkout: process.cwd(),
    command: [process.execPath, '-e', 'process.exit(0)'],
    logPath: join(directory, 'build.log'),
    plistPath: join(directory, 'job.plist'),
    startedAt: started.toISOString(),
    deadlineAt: new Date(started.getTime() + 60_000).toISOString(),
    notificationPending: false,
    ...overrides,
  }
  writeFileSync(join(directory, 'current.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return state
}

beforeAll(async () => {
  notifyServer = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    request.on('end', () => {
      try { notifyBodies.push(JSON.parse(raw) as { title: string; body: string }) } catch { /* malformed bodies stay unrecorded */ }
      const status = notifyStatuses.length > 0 ? notifyStatuses.shift() ?? 500 : 500
      response.statusCode = status
      response.end('ok')
    })
  })
  await new Promise<void>(resolveListen => notifyServer.listen(0, '127.0.0.1', resolveListen))
  const address = notifyServer.address()
  if (address === null || typeof address === 'string') throw new Error('notify server did not bind a port')
  notifyPort = address.port
})

afterAll(async () => {
  await new Promise<void>((resolveClose) => { notifyServer.close(() => { resolveClose() }) })
  for (const [name, value] of Object.entries(previousEnv)) setEnv(name, value)
})

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'anton-rebuild-'))
  notifyStatuses = [200]
  notifyBodies.length = 0
  setEnv('ANTON_REBUILD_DIR', directory)
  setEnv('ANTON_REBUILD_NOTIFY_URL', `http://127.0.0.1:${notifyPort}/bridge/api/notify`)
  setEnv('ANTON_REBUILD_NOTIFY_ATTEMPTS', '2')
  setEnv('ANTON_LAUNCHCTL_PATH', writeFakeLaunchctl(false))
})

afterEach(() => {
  resetRebuildStateForTest()
  rmSync(directory, { recursive: true, force: true })
})

describe('superviseRebuild', () => {
  it('records success and delivers the notification', async () => {
    const seeded = seedState({})
    await expect(superviseRebuild(seeded.jobId)).resolves.toBe(0)
    const state = readRebuildState()
    expect(state?.phase).toBe('succeeded')
    expect(state?.exitCode).toBe(0)
    expect(state?.endedAt).toBeDefined()
    expect(state?.notificationPending).toBe(false)
    expect(notifyBodies[0]?.title).toBe('Anton rebuild completed')
    expect(notifyBodies[0]?.body).toContain(state?.logPath)
  })

  it('records a nonzero build exit as failed', async () => {
    const seeded = seedState({ command: [process.execPath, '-e', 'process.exit(7)'] })
    await expect(superviseRebuild(seeded.jobId)).resolves.toBe(1)
    const state = readRebuildState()
    expect(state?.phase).toBe('failed')
    expect(state?.exitCode).toBe(7)
    expect(state?.detail).toBe('build exited with code 7')
    expect(state?.notificationPending).toBe(false)
    expect(notifyBodies[0]?.title).toBe('Anton rebuild failed')
  })

  it('times the build out and terminates the process group', async () => {
    const seeded = seedState({
      command: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
      deadlineAt: new Date(Date.now() + 150).toISOString(),
    })
    await expect(superviseRebuild(seeded.jobId)).resolves.toBe(1)
    const state = readRebuildState()
    expect(state?.phase).toBe('timed_out')
    expect(state?.detail).toBe('build exceeded its deadline')
    expect(notifyBodies[0]?.title).toBe('Anton rebuild timed out')
  })

  it('marks a cancelled run only after the child exits', async () => {
    const seeded = seedState({ command: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'] })
    const supervised = superviseRebuild(seeded.jobId)
    // The supervisor's own SIGTERM handler is the launchd cancellation path;
    // deliver it while the child runs, exactly as `anton rebuild cancel`
    // would through launchctl.
    setTimeout(() => { process.kill(process.pid, 'SIGTERM') }, 150)
    await expect(supervised).resolves.toBe(1)
    const state = readRebuildState()
    expect(state?.phase).toBe('cancelled')
    expect(state?.detail).toBe('cancelled by user')
    expect(state?.notificationPending).toBe(false)
  })

  it('refuses a job id the state file does not name', async () => {
    seedState({})
    await expect(superviseRebuild('other-job')).resolves.toBe(2)
    expect(readRebuildState()?.phase).toBe('starting')
  })

  it('retries a pending notification after a failed delivery', async () => {
    notifyStatuses = [500, 200]
    const seeded = seedState({})
    await expect(superviseRebuild(seeded.jobId)).resolves.toBe(0)
    expect(readRebuildState()?.notificationPending).toBe(false)
    expect(notifyBodies.length).toBe(2)
  })

  it('leaves notificationPending durable when delivery keeps failing', async () => {
    notifyStatuses = [500, 500]
    const seeded = seedState({})
    await expect(superviseRebuild(seeded.jobId)).resolves.toBe(0)
    const state = readRebuildState()
    expect(state?.phase).toBe('succeeded')
    expect(state?.notificationPending).toBe(true)
    expect(notifyBodies.length).toBe(2)
  })
})

describe('startRebuild', () => {
  it('refuses a duplicate live job without touching it', async () => {
    const seeded = seedState({ phase: 'running', supervisorPid: 4242 })
    setEnv('ANTON_LAUNCHCTL_PATH', writeFakeLaunchctl(true))
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(startRebuild({ timeoutMinutes: 20, checkout: process.cwd() })).resolves.toBe(1)
    } finally {
      stderr.mockRestore()
    }
    expect(readRebuildState()?.jobId).toBe(seeded.jobId)
    expect(readRebuildState()?.phase).toBe('running')
    expect(launchctlLog().some(line => line.startsWith('kill'))).toBe(false)
  })

  it('cleans a stale nonterminal job and starts a fresh one', async () => {
    seedState({ phase: 'running', supervisorPid: 4242 })
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await expect(startRebuild({ timeoutMinutes: 20, checkout: process.cwd() })).resolves.toBe(0)
    } finally {
      stdout.mockRestore()
    }
    const state = readRebuildState()
    expect(state?.phase).toBe('starting')
    expect(state?.command).toEqual(['pnpm', 'run', 'anton:build:macos'])
    const log = launchctlLog()
    expect(log.some(line => line.startsWith('bootout'))).toBe(true)
    expect(log.some(line => line.startsWith('bootstrap'))).toBe(true)
  })

  it('rejects a timeout outside the supported range', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(startRebuild({ timeoutMinutes: 1, checkout: process.cwd() })).resolves.toBe(1)
      await expect(startRebuild({ timeoutMinutes: 121, checkout: process.cwd() })).resolves.toBe(1)
    } finally {
      stderr.mockRestore()
    }
    expect(readRebuildState()).toBeUndefined()
  })

  it('refuses a directory that is not a harness checkout', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(startRebuild({ timeoutMinutes: 20, checkout: directory })).resolves.toBe(1)
    } finally {
      stderr.mockRestore()
    }
    expect(readRebuildState()).toBeUndefined()
  })
})

describe('rebuild status and cancel', () => {
  it('reports idle when no state exists', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await expect(rebuildStatus()).resolves.toBe(0)
    } finally {
      stdout.mockRestore()
    }
  })

  it('fails a nonterminal job whose launchd label is gone, then delivers its pending notification', async () => {
    seedState({ phase: 'running' })
    await expect(rebuildStatus()).resolves.toBe(1)
    const state = readRebuildState()
    expect(state?.phase).toBe('failed')
    expect(state?.detail).toBe('supervisor is no longer registered with launchd')
    // The same status call retries the just-marked pending notification.
    expect(state?.notificationPending).toBe(false)
    expect(notifyBodies.length).toBe(1)
  })

  it('delivers a durably pending notification on status', async () => {
    seedState({ phase: 'succeeded', notificationPending: true, endedAt: new Date().toISOString() })
    // Delivery is a localhost POST with a two-second timeout; under load one
    // status call can miss, and the durable pending flag makes the next
    // status retry — that retry contract is the behavior under test.
    await vi.waitFor(async () => {
      await expect(rebuildStatus()).resolves.toBe(0)
      expect(readRebuildState()?.notificationPending).toBe(false)
    }, { timeout: 20_000, interval: 500 })
    expect(notifyBodies.length).toBe(1)
  })

  it('cancels through launchd, never by signaling the child directly', async () => {
    seedState({ phase: 'running' })
    setEnv('ANTON_LAUNCHCTL_PATH', writeFakeLaunchctl(true))
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await expect(cancelRebuild()).resolves.toBe(0)
    } finally {
      stdout.mockRestore()
    }
    const domain = `gui/${process.getuid?.() ?? 0}`
    expect(launchctlLog()).toContain(`kill SIGTERM ${domain}/dev.antoncode.rebuild.job`)
  })

  it('refuses to cancel when no active rebuild exists', async () => {
    seedState({ phase: 'succeeded', endedAt: new Date().toISOString() })
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(cancelRebuild()).resolves.toBe(1)
    } finally {
      stderr.mockRestore()
    }
  })
})
