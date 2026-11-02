// FileViewer: the built-in text file buffer — the `file.view` keyed
// dispatch's fallback for paths whose viewer key has no registrant (the
// text case and any not-yet-shipped viewer). The content is fetched once
// per path through the injected read face; a fetch failure renders the
// message instead of the body. When the path's extension resolves to a
// grammar (`viewerLanguageFor`), the body renders through the shared
// CodeBlock shiki path — the same surface markdown fences and the read
// card use; unknown extensions take CodeBlock's identical-geometry plain
// fallback.

import { memo, useEffect, useState } from 'react'
/** Copy-affordance labels for the inline viewer's code block. */
const COPY_LABEL = 'Copy'
const COPIED_LABEL = 'Copied'

import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { viewerLanguageFor } from './file-view.ts'
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
      <CodeBlock
        className={css.body} code={state.content} lang={viewerLanguageFor(path)}
        copyLabel={COPY_LABEL} copiedLabel={COPIED_LABEL}
      />
    </div>
  )
})
