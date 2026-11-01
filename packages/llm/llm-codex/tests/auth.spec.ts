import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAccessToken } from '../src/auth.ts'

const cleanups: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function authHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-auth-'))
  const home = join(root, 'codex')
  await mkdir(home, { recursive: true })
  cleanups.push(root)
  return home
}

describe('resolveAccessToken', () => {
  it('forces a refresh when the provider rejects a locally usable token', async () => {
    const home = await authHome()
    await writeFile(join(home, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'stale-access', refresh_token: 'refresh-1', account_id: 'acct-1' },
    }))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'fresh-access',
      refresh_token: 'refresh-2',
      expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveAccessToken(home, true)).resolves.toMatchObject({
      access_token: 'fresh-access',
      refresh_token: 'refresh-2',
      account_id: 'acct-1',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const persisted = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')) as {
      tokens: { access_token: string; refresh_token: string }
    }
    expect(persisted.tokens).toMatchObject({ access_token: 'fresh-access', refresh_token: 'refresh-2' })
  })
})
