// FileViewer: the inline text-file buffer the dired/ido open action routes
// to (image extensions keep the OS default application via openPath). The
// content is fetched once per path through the injected read face; a fetch
// failure renders the message instead of the body.

import { memo, useEffect, useState } from 'react'
import css from './FileViewer.module.css'

export interface FileViewerProps {
  path: string
  readText: (path: string) => Promise<{ content: string; truncated: boolean } | undefined>
}

/** Render the exported component. */
export const FileViewer = memo(function FileViewer({ path, readText }: FileViewerProps) {
  const [state, setState] = useState<{ content: string; truncated: boolean } | undefined>(undefined)
  const [failed, setFailed] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setState(undefined)
    setFailed(undefined)
    void readText(path).then((result) => {
      if (cancelled) return
      if (result === undefined) setFailed('read unavailable')
      else setState(result)
    }, (error: unknown) => {
      if (!cancelled) setFailed(error instanceof Error ? error.message : String(error))
    })
    return () => { cancelled = true }
  }, [path, readText])

  if (failed !== undefined) {
    return <div className={css.root} data-testid="file-viewer"><p className={css.note}>{`${path}: ${failed}`}</p></div>
  }
  if (state === undefined) {
    return <div className={css.root} data-testid="file-viewer"><p className={css.note}>{`${path} — loading…`}</p></div>
  }
  return (
    <div className={css.root} data-testid="file-viewer" data-truncated={state.truncated || undefined}>
      {state.truncated && <p className={css.note}>showing the first 512 KiB</p>}
      <pre className={css.body}>{state.content}</pre>
    </div>
  )
})
