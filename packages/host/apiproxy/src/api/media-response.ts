/**
 * `/api/host/media` response builder: content typing, single-range byte
 * slicing, fs streaming, and the ffmpeg stream-copy remux fallback for the
 * inline image/video viewers. The caller (the downloads domain) owns the
 * browse-capability fence and resolves the absolute path; this module owns
 * everything after it. The transport trust fence is the carrier's — the
 * same prefix-wide `/api` authority check every download channel answers
 * behind (the session.export precedent).
 */
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { MediaDownloadRequest } from './downloads.ts'

/** Content types the inline viewers stream (everything else is octet-stream). */
const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
}

/** The extensions the remux fallback accepts (the video viewer's roster). */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi'])

/**
 * Content type for one path (case-insensitive extension; unknown →
 * application/octet-stream).
 * @param filePath - the file being streamed.
 * @returns the Content-Type value.
 */
export function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  const ext = dot === -1 ? '' : filePath.slice(dot + 1).toLowerCase()
  return MEDIA_CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

/**
 * Parse one single-range `bytes=` header against the file size (RFC 9110
 * range semantics, one range only). Multi-range and non-`bytes` units are
 * deliberately ignored — a server may serve the full body — and an
 * empty-file range is unsatisfiable.
 * @param headerValue - the verbatim Range header value.
 * @param size - the file's byte size.
 * @returns the inclusive slice bounds, `'unsatisfiable'` for a well-formed
 * but out-of-bounds range, or null to serve the full body.
 */
export function parseByteRange(
  headerValue: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (headerValue === undefined || !headerValue.startsWith('bytes=') || headerValue.includes(',')) return null
  const spec = headerValue.slice('bytes='.length)
  const dash = spec.indexOf('-')
  if (dash === -1) return null
  const first = spec.slice(0, dash)
  const last = spec.slice(dash + 1)
  if (first === '' && last === '') return null
  if (first === '') {
    // Suffix form `-S`: the final S bytes (0 is unsatisfiable by spec).
    const suffix = Number(last)
    if (!Number.isInteger(suffix) || suffix <= 0) return 'unsatisfiable'
    if (size === 0) return 'unsatisfiable'
    const start = Math.max(size - suffix, 0)
    return { start, end: size - 1 }
  }
  const start = Number(first)
  if (!Number.isInteger(start) || start < 0) return null
  if (start >= size) return 'unsatisfiable'
  if (last === '') return { start, end: size - 1 }
  const end = Number(last)
  if (!Number.isInteger(end) || end < start) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

/**
 * Whether ffmpeg is available for the remux fallback (a `-version` probe;
 * resolves false when the binary is absent).
 * @returns the probe result.
 */
async function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn('ffmpeg', ['-version'], { stdio: 'ignore' })
    probe.once('error', () => { resolve(false) })
    probe.once('close', (code) => { resolve(code === 0) })
  })
}

/**
 * Build the remux response: ffmpeg stream-copies the video track into
 * fragmented MP4 on stdout while transcoding the audio to AAC — Chromium
 * drops AC-3/DTS/PCM tracks silently (video keeps playing, no error event),
 * so the fallback must produce audio every browser decodes. Audio-only
 * transcode is near-free CPU; the video bytes are never re-encoded. The
 * stream goes straight to the client (instant start, no seek support — the
 * viewer only lands here after native playback failed or stayed silent). A
 * client disconnect kills the child.
 * @param filePath - the source video file.
 * @param signal - caller lifetime.
 * @returns the video/mp4 streaming response.
 */
function remuxResponse(filePath: string, signal: AbortSignal): Response {
  const child = spawn('ffmpeg', [
    '-nostdin', '-i', filePath, '-c:v', 'copy', '-c:a', 'aac',
    '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] })
  const abort = (): void => { child.kill('SIGKILL') }
  signal.addEventListener('abort', abort, { once: true })
  const stream = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  // A spawn failure after headers (disk full, killed binary) surfaces as a
  // truncated body — the status is already committed; the viewer's error
  // state covers it. The abort listener must not outlive the child.
  child.stdout.once('close', () => { signal.removeEventListener('abort', abort) })
  return new Response(stream, { headers: { 'content-type': 'video/mp4', 'cache-control': 'no-store' } })
}

/**
 * Build the media response for one file: stat, content-type, and either the
 * full body, the requested byte slice, the 416 rejection, or the remux
 * fallback stream.
 * @param filePath - absolute file path (the caller fenced the request).
 * @param request - the parsed download request (range + remux flag).
 * @param signal - caller lifetime; abort destroys the file stream.
 * @returns the response; status semantics in {@link DownloadsApi.media}.
 */
export async function mediaFileResponse(filePath: string, request: Pick<MediaDownloadRequest, 'range' | 'remux'>, signal: AbortSignal): Promise<Response> {
  if (request.remux === true) {
    const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
    if (!VIDEO_EXTENSIONS.has(ext)) {
      return new Response('remux applies to video files only', { status: 400 })
    }
    if (!await ffmpegAvailable()) {
      return new Response('remux unavailable: ffmpeg is not installed on the host', { status: 501 })
    }
    return remuxResponse(filePath, signal)
  }
  let size: number
  try {
    const stats = await stat(filePath)
    if (!stats.isFile()) return new Response('not a regular file', { status: 404 })
    size = stats.size
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return new Response('file not found', { status: 404 })
    /* v8 ignore next -- other stat failures (EACCES/EPERM) need host-specific
       permissions; no portable fixture exists */
    return new Response('media stat failed', { status: 500 })
  }
  const slice = parseByteRange(request.range, size)
  if (slice === 'unsatisfiable') {
    return new Response('requested range not satisfiable', {
      status: 416,
      headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes', 'content-type': contentTypeFor(filePath) },
    })
  }
  const stream = createReadStream(filePath, slice === null ? undefined : { start: slice.start, end: slice.end })
  signal.addEventListener('abort', () => { stream.destroy() }, { once: true })
  const headers: Record<string, string> = {
    'content-type': contentTypeFor(filePath),
    'accept-ranges': 'bytes',
    'content-length': String(slice === null ? size : slice.end - slice.start + 1),
  }
  if (slice !== null) headers['content-range'] = `bytes ${slice.start}-${slice.end}/${size}`
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: slice === null ? 200 : 206,
    headers,
  })
}
