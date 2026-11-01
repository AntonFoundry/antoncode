import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { LangflowSidecar } from '../src/sidecar.ts'

const config = {
  command: 'uvx',
  port: 7860,
  workdir: '/tmp/langflow-test',
  readyTimeoutMs: 5_000,
}

interface StubControls {
  spawnCalls: SubprocessSpawnSpec[]
  exit(outcome: SubprocessOutcome): void
  failFetch(): void
}

/**
 * A subprocess runtime stub carrying one controllable child: `done` settles
 * only through `controls.exit`, and fetch stubbing is delegated to the test.
 */
function stubRuntime(): { runtime: SubprocessRuntime; controls: StubControls } {
  const spawnCalls: SubprocessSpawnSpec[] = []
  let settleExit: ((outcome: SubprocessOutcome) => void) | undefined
  const done = new Promise<SubprocessOutcome>((resolve) => {
    settleExit = resolve
  })
  let failFetch = false
  const handle: SubprocessHandle = {
    pid: 4242,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stderr: {
        readFrom: () => ({ text: 'uvx: launcher exploded\ndetail line', nextOffset: 48, lossy: false }),
      },
    },
    done,
    terminate: () => {
      settleExit?.({ exitCode: null, signal: 'SIGTERM' })
    },
    waitForExit: async () => true,
  } as unknown as SubprocessHandle
  const runtime = {
    spawn: (spec: SubprocessSpawnSpec) => {
      spawnCalls.push(spec)
      return handle
    },
  } as unknown as SubprocessRuntime
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (failFetch) throw new Error('connection refused')
    return new Response('{"status":"ok"}', { status: 200 })
  }))
  return { runtime, controls: { spawnCalls, exit: settleExit!, failFetch: () => { failFetch = true } } }
}

function sidecar(runtime: SubprocessRuntime): LangflowSidecar {
  return new LangflowSidecar(runtime, config)
}

describe('LangflowSidecar', () => {
  it('spawns langflow run and reaches running with the URL', async () => {
    const { runtime, controls } = stubRuntime()
    const unit = sidecar(runtime)
    const status = await unit.start()
    expect(controls.spawnCalls).toHaveLength(1)
    const spawn = controls.spawnCalls[0]
    if (spawn === undefined) throw new Error('the stub recorded no spawn')
    expect(spawn.argv).toEqual(['uvx', 'langflow', 'run', '--host', '127.0.0.1', '--port', '7860'])
    expect(spawn.cwd).toBe('/tmp/langflow-test')
    expect(status.state).toBe('running')
    expect(status.url).toBe('http://127.0.0.1:7860/')
    await unit.stop()
  })

  it('shares one spawn across concurrent starts', async () => {
    const { runtime, controls } = stubRuntime()
    const unit = sidecar(runtime)
    const [a, b] = await Promise.all([unit.start(), unit.start()])
    expect(controls.spawnCalls).toHaveLength(1)
    expect(a.state).toBe('running')
    expect(b.state).toBe('running')
    await unit.stop()
  })

  it('reports an error with the stderr tail when the child exits before readiness', async () => {
    const { runtime, controls } = stubRuntime()
    controls.failFetch()
    const unit = sidecar(runtime)
    const pending = unit.start()
    controls.exit({ exitCode: 1, signal: null })
    const status = await pending
    expect(status.state).toBe('error')
    expect(status.error).toContain('code 1')
    expect(status.error).toContain('launcher exploded')
  })

  it('times out into an error state when the server never answers', async () => {
    const { runtime, controls } = stubRuntime()
    controls.failFetch()
    const short = new LangflowSidecar(runtime, { ...config, readyTimeoutMs: 400 })
    const status = await short.start()
    expect(status.state).toBe('error')
    expect(status.error).toContain('did not become ready within 400 ms')
  })

  it('stop terminates the child and resets to stopped', async () => {
    const { runtime } = stubRuntime()
    const unit = sidecar(runtime)
    await unit.start()
    await unit.stop()
    expect(unit.status().state).toBe('stopped')
  })
})
