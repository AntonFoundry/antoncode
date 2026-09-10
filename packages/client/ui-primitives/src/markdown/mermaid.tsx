// MermaidDiagram: settled ```mermaid fences render as diagrams via the
// mermaid library (dynamic import — the fence stream stays a plain code
// block while streaming, mirroring the ```math TeX precedent). Render
// failures fall back to the fenced source with the error named, so a bad
// diagram never erases what the model wrote. mermaid runs at
// securityLevel 'strict': diagram text is escaped, no click handlers, no
// remote fetches inside diagrams.

import { memo, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CodeBlock } from './CodeBlock.tsx'
import css from './mermaid.module.css'

export interface MermaidDiagramProps {
  /** The fence body (diagram source). */
  code: string
  /** Localized fence copy labels for the error fallback's source view. */
  copyLabel: string | undefined
  copiedLabel: string | undefined
  /** Localized labels. */
  labels: {
    rendering: string
    failed: string
    source: string
  }
}

type Render =
  | { phase: 'idle' | 'pending' }
  | { phase: 'ready'; svg: string }
  | { phase: 'failed'; message: string }

/**
 * Render one mermaid diagram to static SVG. The library loads lazily on the
 * first diagram; a module-level promise caches the configured instance.
 * Render ids must be unique per call — mermaid keys its SVG defs by id.
 */
export const MermaidDiagram = memo(function MermaidDiagram({
  code, copyLabel, copiedLabel, labels,
}: MermaidDiagramProps): ReactNode {
  const [render, setRender] = useState<Render>({ phase: 'idle' })
  const mermaidRef = useRef<typeof import('mermaid').default | undefined>(undefined)
  const renderIndex = useRef(0)

  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      setRender({ phase: 'pending' })
      try {
        mermaidRef.current ??= (await import('mermaid')).default
        mermaidRef.current.initialize({ startOnLoad: false, securityLevel: 'strict' })
        renderIndex.current += 1
        const { svg } = await mermaidRef.current.render(`dsh-mermaid-${renderIndex.current}`, code)
        if (!cancelled) setRender({ phase: 'ready', svg })
      } catch (error: unknown) {
        if (!cancelled) {
          setRender({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    void run()
    return () => { cancelled = true }
  }, [code])

  if (render.phase === 'ready') {
    return (
      <div
        key={code.length}
        className={css.diagram}
        data-testid="mermaid-diagram"
        // mermaid's SVG string is generated under securityLevel 'strict'
        // (text escaped, foreignObject off by default there), produced from
        // the diagram grammar rather than the raw model text.
        dangerouslySetInnerHTML={{ __html: render.svg }}
      />
    )
  }
  if (render.phase === 'failed') {
    return (
      <div className={css.failed} data-testid="mermaid-failed">
        <p className={css.failedNote}>{`${labels.failed}: ${render.message}`}</p>
        <CodeBlock
          code={`${code}\n`}
          lang="mermaid"
          copyLabel={copyLabel}
          copiedLabel={copiedLabel}
        />
      </div>
    )
  }
  return <div className={css.pending} data-testid="mermaid-pending">{labels.rendering}</div>
})
