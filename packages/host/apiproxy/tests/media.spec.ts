/**
 * /api/host/media download endpoint: content typing, single-range slicing
 * (200/206/416), HEAD, the browse-capability fence, and the ffmpeg remux
 * fallback (400 non-video, 501 without ffmpeg, streamed fake-ffmpeg body).
 */
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createApiProxy, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'

const CLIP = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

let dir: string
let fetchMedia: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-media-'))
  await writeFile(join(dir, 'clip.png'), CLIP)
  await writeFile(join(dir, 'clip.mp4'), CLIP)
  await writeFile(join(dir, 'movie.mkv'), CLIP)
  await writeFile(join(dir, 'move.mov'), CLIP)
  await writeFile(join(dir, 'clip.webm'), CLIP)
  await writeFile(join(dir, 'm4v.m4v'), CLIP)
  await writeFile(join(dir, 'old.avi'), CLIP)
  await writeFile(join(dir, 'frame.svg'), CLIP)
  await writeFile(join(dir, 'note.txt'), CLIP)
  await writeFile(join(dir, 'empty.png'), new Uint8Array(0))
  const ctx = new Context()
  await ctx.plugin(UserQuestionService)
  ctx.provide('directoryPicker', {
    capability: () => ({ kind: 'browse', list: async () => { throw new Error('unused') } }),
  } as never)
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: dir })
  fetchMedia = toFetchHandler(api).fetch
})

afterAll(() => { vi.unstubAllEnvs() })

function media(path: string, init: { range?: string; remux?: boolean } = {}, method: 'GET' | 'HEAD' = 'GET'): Promise<Response> {
  const params = new URLSearchParams({ path })
  if (init.remux === true) params.set('remux', '1')
  const headers: Record<string, string> = {}
  if (init.range !== undefined) headers.range = init.range
  return fetchMedia(`http://host/api/host/media?${params.toString()}`, { method, headers })
}

describe('media endpoint: typing and full bodies', () => {
  it('streams a full image body with content type, length, and range support', async () => {
    const res = await media(join(dir, 'clip.png'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-length')).toBe('8')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(CLIP)
  })

  it('maps every shipped extension, unknown to octet-stream', async () => {
    for (const [name, type] of [
      ['clip.mp4', 'video/mp4'], ['m4v.m4v', 'video/mp4'], ['movie.mkv', 'video/x-matroska'],
      ['move.mov', 'video/quicktime'], ['clip.webm', 'video/webm'], ['old.avi', 'video/x-msvideo'],
      ['frame.svg', 'image/svg+xml'], ['note.txt', 'application/octet-stream'],
    ] as const) {
      const res = await media(join(dir, name))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe(type)
      await res.body?.cancel()
    }
  })
})

describe('media endpoint: single-range slicing', () => {
  it('answers a satisfiable closed range with 206 and Content-Range', async () => {
    const res = await media(join(dir, 'clip.png'), { range: 'bytes=2-5' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-5/8')
    expect(res.headers.get('content-length')).toBe('4')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([3, 4, 5, 6]))
  })

  it('answers open-ended and suffix ranges', async () => {
    const open = await media(join(dir, 'clip.png'), { range: 'bytes=6-' })
    expect(open.status).toBe(206)
    expect(open.headers.get('content-range')).toBe('bytes 6-7/8')
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(new Uint8Array([7, 8]))
    const suffix = await media(join(dir, 'clip.png'), { range: 'bytes=-3' })
    expect(suffix.headers.get('content-range')).toBe('bytes 5-7/8')
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(new Uint8Array([6, 7, 8]))
  })

  it('clamps an end past the file and rejects out-of-bounds starts with 416', async () => {
    const clamped = await media(join(dir, 'clip.png'), { range: 'bytes=0-100' })
    expect(clamped.status).toBe(206)
    expect(clamped.headers.get('content-range')).toBe('bytes 0-7/8')
    const unsat = await media(join(dir, 'clip.png'), { range: 'bytes=100-' })
    expect(unsat.status).toBe(416)
    expect(unsat.headers.get('content-range')).toBe('bytes */8')
  })

  it('ignores multi-range, non-bytes units, and malformed specs by serving the full body', async () => {
    for (const range of ['bytes=0-1,3-4', 'items=0-1', 'bytes=5', 'bytes=-']) {
      const res = await media(join(dir, 'clip.png'), { range })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-range')).toBeNull()
      await res.body?.cancel()
    }
  })

  it('rejects a reversed range and a zero suffix', async () => {
    const reversed = await media(join(dir, 'clip.png'), { range: 'bytes=5-2' })
    expect(reversed.status).toBe(416)
    const zeroSuffix = await media(join(dir, 'clip.png'), { range: 'bytes=-0' })
    expect(zeroSuffix.status).toBe(416)
  })

  it('serves an empty file full and treats any range on it as unsatisfiable', async () => {
    const full = await media(join(dir, 'empty.png'))
    expect(full.status).toBe(200)
    expect(full.headers.get('content-length')).toBe('0')
    expect((await full.arrayBuffer()).byteLength).toBe(0)
    const ranged = await media(join(dir, 'empty.png'), { range: 'bytes=0-' })
    expect(ranged.status).toBe(416)
    expect(ranged.headers.get('content-range')).toBe('bytes */0')
  })
})

describe('media endpoint: carrier behavior and fences', () => {
  it('answers HEAD with the same status and headers and no body', async () => {
    const res = await media(join(dir, 'clip.png'), {}, 'HEAD')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('8')
    expect(await res.arrayBuffer()).toHaveProperty('byteLength', 0)
  })

  it('answers a missing or empty path parameter with 400', async () => {
    expect((await fetchMedia('http://host/api/host/media')).status).toBe(400)
    expect((await fetchMedia('http://host/api/host/media?path=')).status).toBe(400)
  })

  it('answers a missing file and a directory target with 404', async () => {
    expect((await media(join(dir, 'absent.png'))).status).toBe(404)
    expect((await media(dir)).status).toBe(404)
  })

  it('refuses non-browse pickers with 500 naming the served capability', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    ctx.provide('directoryPicker', { capability: () => ({ kind: 'native', pick: async () => null }) } as never)
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: dir })
    const res = await toFetchHandler(api).fetch(`http://host/api/host/media?path=${encodeURIComponent(join(dir, 'clip.png'))}`)
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('the composed picker serves "native"')
  })
})

describe('media endpoint: ffmpeg remux fallback', () => {
  it('rejects a remux request on a non-video file with 400', async () => {
    const res = await media(join(dir, 'note.txt'), { remux: true })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('video files only')
  })

  it('answers 501 when ffmpeg is not on the host PATH', async () => {
    const emptyBin = await mkdtemp(join(tmpdir(), 'dsh-media-nobin-'))
    vi.stubEnv('PATH', emptyBin)
    const res = await media(join(dir, 'movie.mkv'), { remux: true })
    expect(res.status).toBe(501)
    expect(await res.text()).toContain('ffmpeg is not installed')
  })

  it('streams the ffmpeg stdout as video/mp4 when available', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'dsh-media-bin-'))
    const fake = join(fakeBin, 'ffmpeg')
    await writeFile(fake, '#!/bin/sh\nprintf FAKE-MP4\n')
    await chmod(fake, 0o755)
    vi.stubEnv('PATH', fakeBin)
    const res = await media(join(dir, 'movie.mkv'), { remux: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(await res.text()).toBe('FAKE-MP4')
  })

  it('a caller abort kills the stream path (pre-aborted signal settles immediately)', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'dsh-media-bin2-'))
    const fake = join(fakeBin, 'ffmpeg')
    await writeFile(fake, '#!/bin/sh\nsleep 5\n')
    await chmod(fake, 0o755)
    vi.stubEnv('PATH', fakeBin)
    const controller = new AbortController()
    controller.abort()
    const res = await fetchMedia(
      `http://host/api/host/media?path=${encodeURIComponent(join(dir, 'movie.mkv'))}&remux=1`,
      { signal: controller.signal },
    )
    // The child is killed through the abort listener; the body settles without hanging.
    await expect(res.arrayBuffer()).resolves.toBeDefined()
  })
})
