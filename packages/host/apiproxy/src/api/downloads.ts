/**
 * downloads domain contract: host-only download surfaces — the GET-download
 * channel family, the mirror of the SSE-stream `events` domain. No wire
 * envelope: the carrier's GET routes answer these directly, and the browser
 * `IApiClient` never exposes them.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Host-only download surfaces (no wire envelope; absent from IApiClient). */
export interface DownloadsApi {
  /**
   * Stream one session-log ZIP — the root artifact verbatim plus each subagent
   * descendant's — as an attachment response. The carrier's GET route answers
   * this directly; the browser never calls it.
   * @param request - the root session id and whether to include descendants.
   * @param signal - cancellation for the underlying reads.
   * @returns the ZIP attachment response; missing services answer 500 and a
   * missing root session 404 before any byte is produced.
   */
  sessionLog(
    request: { sessionId: SessionId; includeDescendants?: boolean },
    signal: AbortSignal,
  ): Promise<Response>

  /**
   * Stream one workspace file to the inline media viewers (the image and
   * video `file.view` occupants): content-typed, single-range sliceable
   * (HTTP Range), optionally ffmpeg stream-copy remuxed to fragmented MP4.
   * The carrier's GET route answers this directly; the browser never calls
   * it through the RPC client.
   * @param request - the absolute file path, the verbatim Range header, and
   * whether the caller asked for the remux fallback.
   * @param signal - caller lifetime; abort stops the stream (and kills the
   * ffmpeg child in remux mode).
   * @returns the media response: 200 full body, 206 for a satisfiable range,
   * 416 for an unsatisfiable one, 404/500 for unreadable targets, 501 when a
   * remux was requested but the host has no ffmpeg, 400 for a remux request
   * on a non-video file.
   */
  media(
    request: MediaDownloadRequest,
    signal: AbortSignal,
  ): Promise<Response>
}

/** One `/api/host/media` download request (query params + Range header). */
export interface MediaDownloadRequest {
  /** Absolute path of the file to stream. */
  path: string
  /** The HTTP Range header verbatim; absent or non-`bytes` means the full body. */
  range?: string
  /** Stream-copy remux to fragmented MP4 through ffmpeg (video files only). */
  remux?: boolean
}
