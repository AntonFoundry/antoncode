/**
 * The inline markdown file viewer: one `file.view` keyed-slot occupant
 * (key `markdown`). The frame dispatches every `.md`/`.markdown` file buffer
 * here with the file-view owner share; the content fetch rides the same
 * read face the plain-text fallback uses, and rendering rides the shared
 * `MarkdownText` engine (ui-primitives) — the assistant-output renderer, so
 * GFM, code highlighting, tables, and math behave exactly as in chat. No
 * second markdown pipeline exists in this package.
 */
import { memo, useEffect, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './MarkdownFileView.module.css'

/** Full composed props of the markdown viewer (the file-view owner share; root scope adds nothing). */
export type MarkdownFileViewProps = PropsRuntime<'file.view'>

/**
 * Render one markdown file buffer.
 * @param props - the file-view owner share (path + read face; mediaUrl and
 *   openWithOs belong to the binary viewers and go unused here).
 * @returns the rendered markdown body.
 */
export const MarkdownFileView = memo(function MarkdownFileView({ path, readText }: MarkdownFileViewProps) {
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
    return <div className={css.root} data-testid="markdown-file-view"><p className={css.note}>{`${path}: ${failed}`}</p></div>
  }
  if (state === undefined) {
    return <div className={css.root} data-testid="markdown-file-view"><p className={css.note}>{`${path} — loading…`}</p></div>
  }
  return (
    <div className={css.root} data-testid="markdown-file-view" data-truncated={state.truncated || undefined}>
      {state.truncated && <p className={css.note}>showing the first 512 KiB</p>}
      <div className={css.body}><MarkdownText text={state.content} /></div>
    </div>
  )
})
