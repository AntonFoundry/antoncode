/**
 * The inline markdown file viewer: one `file.view` keyed-slot occupant
 * (key `markdown`). The frame dispatches every `.md`/`.markdown` file buffer
 * here with the file-view owner share; the content fetch rides the same
 * read face the plain-text fallback uses, and rendering rides the shared
 * `MarkdownText` engine (ui-primitives) — the assistant-output renderer, so
 * GFM, code highlighting, tables, and math behave exactly as in chat. No
 * second markdown pipeline exists in this package.
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import css from './MarkdownFileView.module.css'

/** Full composed props of the markdown viewer: the file-view owner share plus the `fileMarkdown` copy. */
export type MarkdownFileViewProps = PropsRuntime<'file.view'> & PropsLocale<'fileMarkdown'>

/**
 * Render one markdown file buffer.
 * @param props - the file-view owner share (path + read face; mediaUrl and
 *   openWithOs belong to the binary viewers and go unused here) and the
 *   viewer copy, including the MarkdownText code and footnote chrome.
 * @returns the rendered markdown body.
 */
export const MarkdownFileView = memo(function MarkdownFileView({ path, readText, t }: MarkdownFileViewProps) {
  const [state, setState] = useState<{ content: string; truncated: boolean } | undefined>(undefined)
  const [failed, setFailed] = useState<string | undefined>(undefined)
  const unavailable = t('readUnavailable')
  const copyLabel = t('code.copy')
  const copiedLabel = t('code.copied')
  const codeLabel = t('codeBlock.title')
  const wrapLabel = t('codeBlock.wrap')
  const unwrapLabel = t('codeBlock.unwrap')
  const footnotes = t('footnotes')
  // MarkdownText keys its render cache on the labels identity, so the object
  // changes only when the active locale's copy does.
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel, copiedLabel, toolbarLabels: { codeLabel, wrapLabel, unwrapLabel } }, footnotes,
  }), [copyLabel, copiedLabel, codeLabel, wrapLabel, unwrapLabel, footnotes])

  useEffect(() => {
    let cancelled = false
    setState(undefined)
    setFailed(undefined)
    void readText(path).then((result) => {
      if (cancelled) return
      if (result === undefined) setFailed(unavailable)
      else setState(result)
    }, (error: unknown) => {
      if (!cancelled) setFailed(error instanceof Error ? error.message : String(error))
    })
    return () => { cancelled = true }
  }, [path, readText, unavailable])

  if (failed !== undefined) {
    return <div className={css.root} data-testid="markdown-file-view"><p className={css.note}>{t('failed', { path, message: failed })}</p></div>
  }
  if (state === undefined) {
    return <div className={css.root} data-testid="markdown-file-view"><p className={css.note}>{t('loading', { path })}</p></div>
  }
  return (
    <div className={css.root} data-testid="markdown-file-view" data-truncated={state.truncated || undefined}>
      {state.truncated && <p className={css.note}>{t('truncated')}</p>}
      <div className={css.body}><MarkdownText text={state.content} labels={labels} /></div>
    </div>
  )
})
