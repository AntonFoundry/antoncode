/**
 * The inline image file viewer: one `file.view` keyed-slot occupant (key
 * `image`). The frame dispatches every browser-renderable image buffer here
 * with the file-view owner share; the pixels stream from the trust-fenced
 * `/api/host/media` endpoint through `mediaUrl` — the browser fetches and
 * decodes them, so the viewer holds no bytes. SVG renders as an `<img>`:
 * the browser sandbox never runs its embedded scripts. A load failure keeps
 * the pane usable: a retry re-requests the URL, and the OS-open escape
 * hatch hands the path to the host's default application.
 */
import { memo, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ImageFileView.module.css'

/** Full composed props of the image viewer (the file-view owner share; root scope adds nothing). */
export type ImageFileViewProps = PropsRuntime<'file.view'>

/**
 * Render one image file buffer.
 * @param props - the file-view owner share (path + mediaUrl; readText and
 *   openWithOs belong to the other viewers — openWithOs is the failure-path
 *   escape hatch).
 * @returns the rendered image stage.
 */
export const ImageFileView = memo(function ImageFileView({ path, mediaUrl, openWithOs }: ImageFileViewProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [attempt, setAttempt] = useState(0)
  return (
    <div className={css.root} data-testid="image-file-view">
      {status === 'loading' && <p className={css.note}>{`${path} — loading…`}</p>}
      {status === 'failed' && (
        <div className={css.failed} data-testid="image-file-view-failed">
          <p className={css.note}>{`${path} — could not load this image`}</p>
          <div className={css.actions}>
            <button
              type="button"
              className={css.action}
              onClick={() => { setStatus('loading'); setAttempt(a => a + 1) }}
            >
              Retry
            </button>
            <button type="button" className={css.action} onClick={() => { openWithOs(path) }}>
              Open with default app
            </button>
          </div>
        </div>
      )}
      <img
        // The key re-mounts the element on retry so a failed URL re-requests
        // even when the browser cached the error.
        key={attempt}
        className={css.image}
        src={mediaUrl(path)}
        alt={path}
        data-status={status}
        onLoad={() => { setStatus('ready') }}
        onError={() => { setStatus('failed') }}
      />
    </div>
  )
})
