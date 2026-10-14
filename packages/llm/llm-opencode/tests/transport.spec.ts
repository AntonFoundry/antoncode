/**
 * Unit tests for local opencode server discovery: URL precedence, password
 * sources, and header formation all resolve through an injected system
 * boundary, with the production file/CLI defaults exercised against temp
 * resources (including a fake `opencode` executable for status discovery).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import {
  DEFAULT_PASSWORD_ENV,
  DEFAULT_USERNAME,
  EXECUTABLE_ENV,
  SERVER_URL_ENV,
  SERVICE_FILE,
  defaultSystem,
  resolveServerTransport,
  type TransportSystem,
} from '../src/transport.ts'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function tempdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-llm-opencode-'))
  dirs.push(dir)
  return dir
}

function systemOf(overrides: Partial<TransportSystem> = {}): TransportSystem {
  return {
    env: {},
    home: '/nonexistent-home',
    readServiceFile: () => Promise.resolve(undefined),
    readPasswordFile: () => Promise.resolve(undefined),
    serviceStatus: () => Promise.resolve(undefined),
    serviceStart: () => Promise.resolve(undefined),
    ...overrides,
  }
}

function basicAuth(headers: Record<string, string>): [string, string] {
  const value = headers.authorization ?? ''
  const [scheme, encoded] = value.split(' ', 2)
  return [scheme ?? '', Buffer.from(encoded ?? '', 'base64').toString('utf8')]
}

describe('resolveServerTransport URL discovery', () => {
  it('rejects an empty explicit serverURL', async () => {
    await expect(resolveServerTransport({ serverURL: '' }, systemOf())).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('prefers the explicit serverURL over every discovery source', async () => {
    const system = systemOf({
      env: { [SERVER_URL_ENV]: 'http://env:1' },
      serviceStatus: () => Promise.resolve('http://status:1'),
      readPasswordFile: () => Promise.resolve('pw'),
    })
    const transport = await resolveServerTransport({ serverURL: 'http://explicit:1/' }, system)
    expect(transport.url).toBe('http://explicit:1')
    const [, userpass] = basicAuth(transport.headers)
    expect(userpass).toBe(`${DEFAULT_USERNAME}:pw`)
  })

  it('honors a non-empty environment URL without calling status discovery', async () => {
    let statusCalls = 0
    const system = systemOf({
      env: { [SERVER_URL_ENV]: 'http://env:2' },
      serviceStatus: () => {
        statusCalls += 1
        return Promise.resolve('http://status:2')
      },
    })
    const transport = await resolveServerTransport({}, system)
    expect(transport.url).toBe('http://env:2')
    expect(statusCalls).toBe(0)
    expect(transport.headers).toEqual({})
  })

  it('skips a blank environment URL and falls through to status discovery', async () => {
    const system = systemOf({
      env: { [SERVER_URL_ENV]: '' },
      serviceStatus: () => Promise.resolve('http://status:3'),
    })
    await expect(resolveServerTransport({}, system)).resolves.toMatchObject({ url: 'http://status:3' })
  })

  it('discovers URL and password from the registration file without the CLI', async () => {
    let statusCalls = 0
    let passwordFileCalls = 0
    const system = systemOf({
      serviceStatus: () => {
        statusCalls += 1
        return Promise.resolve(undefined)
      },
      readServiceFile: () => Promise.resolve({ url: 'http://file:4/', password: 'file-pw' }),
      readPasswordFile: () => {
        passwordFileCalls += 1
        return Promise.resolve('ignored-pw')
      },
    })
    const transport = await resolveServerTransport({}, system)
    expect(transport.url).toBe('http://file:4')
    expect(basicAuth(transport.headers)).toEqual(['Basic', `${DEFAULT_USERNAME}:file-pw`])
    expect(statusCalls).toBe(0)
    expect(passwordFileCalls).toBe(0)
  })

  it('falls back to CLI discovery for a password-only registration file', async () => {
    const system = systemOf({
      readServiceFile: () => Promise.resolve({ password: 'reg-pw' }),
      serviceStatus: () => Promise.resolve('http://status:5'),
    })
    const transport = await resolveServerTransport({}, system)
    expect(transport.url).toBe('http://status:5')
    expect(basicAuth(transport.headers)).toEqual(['Basic', `${DEFAULT_USERNAME}:reg-pw`])
  })

  it('falls back to the password file for a URL-only registration file', async () => {
    const system = systemOf({
      readServiceFile: () => Promise.resolve({ url: 'http://file:6' }),
      readPasswordFile: () => Promise.resolve('pw-file-pw'),
      serviceStatus: () => Promise.resolve('http://status:6'),
    })
    const transport = await resolveServerTransport({}, system)
    expect(transport.url).toBe('http://file:6')
    expect(basicAuth(transport.headers)).toEqual(['Basic', `${DEFAULT_USERNAME}:pw-file-pw`])
  })

  it('reads the registration file at the configured path', async () => {
    const system = systemOf({
      readServiceFile: path => Promise.resolve(path === '/custom/state.json' ? { url: 'http://custom:7' } : undefined),
      serviceStatus: () => Promise.resolve('http://status:7'),
    })
    const transport = await resolveServerTransport({ serviceFile: '/custom/state.json' }, system)
    expect(transport.url).toBe('http://custom:7')
  })

  it('fails TRANSPORT when no source names a server', async () => {
    await expect(resolveServerTransport({}, systemOf())).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('starts an absent service and reads its new password', async () => {
    let started = false
    const system = systemOf({
      readServiceFile: () => Promise.resolve(started ? { password: 'new-password' } : undefined),
      serviceStart: () => {
        started = true
        return Promise.resolve('http://started:8')
      },
    })
    const transport = await resolveServerTransport({}, system)
    expect(transport.url).toBe('http://started:8')
    expect(basicAuth(transport.headers)).toEqual(['Basic', `${DEFAULT_USERNAME}:new-password`])
  })

  it('does not start a service when autoStart is disabled', async () => {
    let starts = 0
    const system = systemOf({
      serviceStart: () => {
        starts += 1
        return Promise.resolve('http://started:9')
      },
    })
    await expect(resolveServerTransport({ autoStart: false }, system)).rejects.toMatchObject({ code: 'TRANSPORT' })
    expect(starts).toBe(0)
  })
})

describe('resolveServerTransport credentials', () => {
  it('rejects an empty username', async () => {
    const system = systemOf({ serviceStatus: () => Promise.resolve('http://s:1') })
    await expect(resolveServerTransport({ username: '' }, system)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('stamps the configured username into the Basic credential', async () => {
    const system = systemOf({
      serviceStatus: () => Promise.resolve('http://s:2'),
      readPasswordFile: () => Promise.resolve('pw'),
    })
    const transport = await resolveServerTransport({ username: 'operator' }, system)
    expect(basicAuth(transport.headers)).toEqual(['Basic', 'operator:pw'])
  })

  it('reads the password file at the configured path', async () => {
    const system = systemOf({
      serviceStatus: () => Promise.resolve('http://s:3'),
      readPasswordFile: path => Promise.resolve(path === '/custom/service.json' ? 'file-pw' : undefined),
    })
    const transport = await resolveServerTransport({ passwordFile: '/custom/service.json' }, system)
    expect(basicAuth(transport.headers)).toEqual(['Basic', `${DEFAULT_USERNAME}:file-pw`])
  })

  it('falls back to the default password environment variable', async () => {
    const system = systemOf({
      env: { [DEFAULT_PASSWORD_ENV]: 'env-pw' },
      serviceStatus: () => Promise.resolve('http://s:4'),
    })
    const transport = await resolveServerTransport({}, system)
    expect(basicAuth(transport.headers)).toEqual(['Basic', `${DEFAULT_USERNAME}:env-pw`])
  })

  it('honors a custom password environment name', async () => {
    const system = systemOf({
      env: { CUSTOM_PW: 'custom-pw' },
      serviceStatus: () => Promise.resolve('http://s:5'),
    })
    const transport = await resolveServerTransport({ passwordEnv: 'CUSTOM_PW' }, system)
    expect(basicAuth(transport.headers)).toEqual(['Basic', `${DEFAULT_USERNAME}:custom-pw`])
  })

  it('sends no auth headers when every password source is empty', async () => {
    const system = systemOf({
      env: { [DEFAULT_PASSWORD_ENV]: '' },
      serviceStatus: () => Promise.resolve('http://s:6'),
    })
    const transport = await resolveServerTransport({}, system)
    expect(transport.headers).toEqual({})
  })
})

describe('production system defaults', () => {
  it('reads the service-file password through the default boundary', async () => {
    const dir = tempdir()
    const file = join(dir, 'service.json')
    writeFileSync(file, JSON.stringify({ password: 'real-pw' }))
    const system: TransportSystem = {
      ...defaultSystem({}),
      readServiceFile: () => Promise.resolve(undefined),
    }
    const transport = await resolveServerTransport({ serverURL: 'http://s:7', passwordFile: file }, system)
    expect(basicAuth(transport.headers)).toEqual(['Basic', `${DEFAULT_USERNAME}:real-pw`])
  })

  it('treats a missing, malformed, or passwordless service file as no password', async () => {
    const dir = tempdir()
    const missing = join(dir, 'missing.json')
    const malformed = join(dir, 'malformed.json')
    writeFileSync(malformed, 'not json{{{')
    const passwordless = join(dir, 'passwordless.json')
    writeFileSync(passwordless, JSON.stringify({ username: 'opencode' }))
    const emptyPw = join(dir, 'empty.json')
    writeFileSync(emptyPw, JSON.stringify({ password: '' }))
    const nonObject = join(dir, 'array.json')
    writeFileSync(nonObject, JSON.stringify(['x']))
    const system: TransportSystem = {
      ...defaultSystem({}),
      readServiceFile: () => Promise.resolve(undefined),
    }
    for (const passwordFile of [missing, malformed, passwordless, emptyPw, nonObject]) {
      const transport = await resolveServerTransport({ serverURL: 'http://s:8', passwordFile }, system)
      expect(transport.headers).toEqual({})
    }
  })

  it('reads URL and password from a registration file through the default boundary', async () => {
    const dir = tempdir()
    const full = join(dir, 'full.json')
    writeFileSync(full, JSON.stringify({ id: 'x', url: 'http://reg:9', password: 'reg-pw', pid: 1 }))
    const system = defaultSystem({})
    const transport = await resolveServerTransport(
      { serviceFile: full, passwordFile: join(dir, 'no-pw.json') },
      system,
    )
    expect(transport.url).toBe('http://reg:9')
    expect(basicAuth(transport.headers)).toEqual(['Basic', `${DEFAULT_USERNAME}:reg-pw`])
  })

  it('treats partial and malformed registration files as absent', async () => {
    const dir = tempdir()
    const noPassword = join(dir, 'no-pw.json')
    const urlOnly = join(dir, 'url-only.json')
    writeFileSync(urlOnly, JSON.stringify({ url: 'http://reg:10' }))
    const emptyStrings = join(dir, 'empty-strings.json')
    writeFileSync(emptyStrings, JSON.stringify({ url: '', password: '' }))
    const emptyObject = join(dir, 'empty-object.json')
    writeFileSync(emptyObject, JSON.stringify({}))
    const malformed = join(dir, 'malformed.json')
    writeFileSync(malformed, 'not json{{{')
    const system = defaultSystem({})
    for (const serviceFile of [urlOnly, emptyStrings, emptyObject, malformed, join(dir, 'missing.json')]) {
      const transport = await resolveServerTransport(
        { serverURL: 'http://s:10', serviceFile, passwordFile: noPassword },
        system,
      )
      expect(transport.url).toBe('http://s:10')
      expect(transport.headers).toEqual({})
    }
  })

  it('resolves the registration file from XDG_STATE_HOME when set', async () => {
    const dir = tempdir()
    const stateFile = join(dir, 'opencode', SERVICE_FILE)
    mkdirSync(join(dir, 'opencode'), { recursive: true })
    writeFileSync(stateFile, JSON.stringify({ url: 'http://xdg:11', password: 'xdg-pw' }))
    const seen: string[] = []
    const system = defaultSystem({ XDG_STATE_HOME: dir })
    const probing: TransportSystem = {
      ...system,
      readServiceFile: (path) => {
        seen.push(path)
        return system.readServiceFile(path)
      },
    }
    const transport = await resolveServerTransport({}, probing)
    expect(seen).toEqual([stateFile])
    expect(transport.url).toBe('http://xdg:11')
  })

  it('falls back to the home state dir for a blank XDG_STATE_HOME', async () => {
    const seen: string[] = []
    const system = defaultSystem({ XDG_STATE_HOME: '' })
    const probing: TransportSystem = {
      ...system,
      readServiceFile: (path) => {
        seen.push(path)
        return Promise.resolve(undefined)
      },
      serviceStatus: () => Promise.resolve(undefined),
    }
    await expect(resolveServerTransport({ autoStart: false }, probing)).rejects.toMatchObject({ code: 'TRANSPORT' })
    expect(seen[0]?.endsWith(join('.local', 'state', 'opencode', SERVICE_FILE))).toBe(true)
  })

  it('discovers the status URL from a fake opencode executable', async () => {
    const dir = tempdir()
    writeFileSync(join(dir, 'opencode'), '#!/bin/sh\necho "http://fake:4321"\n')
    chmodSync(join(dir, 'opencode'), 0o755)
    writeFileSync(join(dir, 'opencode.cmd'), '@echo http://fake:4321\r\n')
    vi.stubEnv('PATH', `${dir}${delimiter}${process.env.PATH ?? ''}`)
    const system: TransportSystem = {
      ...defaultSystem({}),
      readServiceFile: () => Promise.resolve(undefined),
    }
    const transport = await resolveServerTransport({}, system)
    expect(transport.url).toBe('http://fake:4321')
  })

  it('reports no status when the opencode executable is absent', async () => {
    const dir = tempdir()
    vi.stubEnv('PATH', dir)
    vi.stubEnv(EXECUTABLE_ENV, join(dir, 'missing-opencode'))
    const system: TransportSystem = {
      ...defaultSystem({}),
      readServiceFile: () => Promise.resolve(undefined),
    }
    await expect(resolveServerTransport({}, system)).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('reports no status when the executable answers blank', async () => {
    const dir = tempdir()
    writeFileSync(join(dir, 'opencode'), '#!/bin/sh\necho ""\n')
    chmodSync(join(dir, 'opencode'), 0o755)
    writeFileSync(join(dir, 'opencode.cmd'), '@echo.\r\n')
    vi.stubEnv('PATH', `${dir}${delimiter}${process.env.PATH ?? ''}`)
    vi.stubEnv(EXECUTABLE_ENV, join(dir, 'opencode'))
    const system: TransportSystem = {
      ...defaultSystem({}),
      readServiceFile: () => Promise.resolve(undefined),
    }
    await expect(resolveServerTransport({}, system)).rejects.toMatchObject({ code: 'TRANSPORT' })
  })
})
