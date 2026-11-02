/**
 * The inline video file viewer: one `file.view` keyed-slot occupant (key
 * `video`). Playback streams from the trust-fenced `/api/host/media`
 * endpoint through `mediaUrl`; the browser's own decoders play what they
 * support (h264/aac MP4 and WebM typically). A native playback error flips
 * the source ONCE to the endpoint's ffmpeg stream-copy remux
 * (`&remux=1` — fixes container problems such as h264-in-MKV/MOV); a second
 * error gives up into the failure note with a retry and the OS-open escape
 * hatch (the codecs no browser here decodes need a real player anyway).
 */
import { memo, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './VideoFileView.module.css'

/** Full composed props of the video viewer (the file-view owner share; root scope adds nothing). */
export type VideoFileViewProps = PropsRuntime<'file.view'>

/** The playback source stages: native file → remuxed stream → failure note. */
type Stage = 'native' | 'remux' | 'failed'

/**
 * Render one video file buffer.
 * @param props - the file-view owner share (path + mediaUrl; readText and
 *   openWithOs belong to the other viewers — openWithOs is the failure-path
 *   escape hatch).
 * @returns the rendered video stage.
 */
export const VideoFileView = memo(function VideoFileView({ path, mediaUrl, openWithOs }: VideoFileViewProps) {
  const [stage, setStage] = useState<Stage>('native')
  const [attempt, setAttempt] = useState(0)
  if (stage === 'failed') {
    return (
      <div className={css.root} data-testid="video-file-view">
        <div className={css.failed}>
          <p className={css.note}>{`${path} — this video cannot be played inline`}</p>
          <div className={css.actions}>
            <button
              type="button"
              className={css.action}
              onClick={() => { setStage('native'); setAttempt(a => a + 1) }}
            >
              Retry
            </button>
            <button type="button" className={css.action} onClick={() => { openWithOs(path) }}>
              Open with default app
            </button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className={css.root} data-testid="video-file-view" data-stage={stage}>
      <video
        // The key re-mounts on stage/attempt changes so the browser re-opens
        // the source instead of keeping the failed element's state.
        key={`${stage}:${attempt}`}
        className={css.video}
        src={stage === 'remux' ? `${mediaUrl(path)}&remux=1` : mediaUrl(path)}
        controls
        preload="metadata"
        onError={() => { setStage(s => (s === 'native' ? 'remux' : 'failed')) }}
      />
      {stage === 'native' && (
        // A stream whose video decodes but whose audio track does not (AC-3,
        // DTS in mkv) plays silently and fires no error event, so the
        // automatic remux fallback cannot trigger — this affordance is the
        // manual rescue: remux converts the audio to AAC, video stays
        // stream-copied.
        <p className={css.hint}>
          No sound?{' '}
          <button type="button" className={css.hintAction} onClick={() => { setStage('remux') }}>
            Play via remux
          </button>
          {' '}(converts the audio track to AAC)
        </p>
      )}
    </div>
  )
})
