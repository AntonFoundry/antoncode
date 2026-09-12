// MermaidDiagram: settled ```mermaid fences render as diagrams via the
// mermaid library (dynamic import — the fence stream stays a plain code
// block while streaming, mirroring the ```math TeX precedent). Render
// failures fall back to the fenced source with the error named, so a bad
// diagram never erases what the model wrote. mermaid runs at
// securityLevel 'strict': diagram text is escaped, no click handlers, no
// remote fetches inside diagrams. A ready diagram carries a copy-image
// control: the SVG rasterizes to PNG on canvas and lands on the clipboard
// (a download falls out where the clipboard refuses).

import { memo, useEffect, useRef, useState } from 'react'
import type { ReactNode, WheelEvent } from 'react'
import { CodeBlock } from './CodeBlock.tsx'
import css from './mermaid.module.css'

export interface MermaidLabels {
  rendering: string
  failed: string
  copyImage: string
  copied: string
  copiedFailed: string
  zoomIn: string
  zoomOut: string
  resetZoom: string
}

export interface MermaidDiagramProps {
  /** The fence body (diagram source). */
  code: string
  /** Localized fence copy labels for the error fallback's source view. */
  copyLabel: string | undefined
  copiedLabel: string | undefined
  /** Localized labels. */
  labels: MermaidLabels
}

/** Zoom bounds and step for the diagram controls. */
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP = 0.5

type Render =
  | { phase: 'idle' | 'pending' }
  | { phase: 'ready'; svg: string }
  | { phase: 'failed'; message: string }

/**
 * The harness color scheme mermaid should match: the theme presenter stamps
 * `colorScheme` on the document element (and `data-ds-dark-theme` on body),
 * so no cordis knowledge is needed this deep in the render tree.
 * @returns 'dark' for dark schemes, 'default' (mermaid's light) otherwise.
 */
export function activeMermaidTheme(): 'dark' | 'default' {
  const inline = document.documentElement.style.colorScheme
  if (inline === 'dark' || inline === 'light') return inline === 'dark' ? 'dark' : 'default'
  // toggleAttribute sets a bare boolean attribute when dark.
  if (document.body?.hasAttribute('data-ds-dark-theme') === true) return 'dark'
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
  return 'default'
}

/** Raster dimensions derived from the SVG's own width/height or viewBox. */
export function svgDimensions(svg: string, scale: number): { width: number; height: number } | undefined {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  if (root.nodeName !== 'svg') return undefined
  let width = Number.parseFloat(root.getAttribute('width') ?? '')
  let height = Number.parseFloat(root.getAttribute('height') ?? '')
  const viewBox = root.getAttribute('viewBox')
  if (viewBox !== null) {
    const parts = viewBox.split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      width = parts[2] ?? width
      height = parts[3] ?? height
    }
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return { width: Math.ceil(width * scale), height: Math.ceil(height * scale) }
}

/**
 * SVG string → PNG blob at 2× device scale. The SVG is re-serialized with
 * explicit pixel dimensions (mermaid emits style-based sizing the Image
 * decoder ignores), drawn on canvas, and encoded.
 * @param svg - the mermaid-generated SVG markup.
 * @returns the PNG blob.
 */
export async function svgToPngBlob(svg: string): Promise<Blob> {
  const dimensions = svgDimensions(svg, 2)
  if (dimensions === undefined) throw new Error('diagram has no drawable size')
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  root.setAttribute('width', String(dimensions.width))
  root.setAttribute('height', String(dimensions.height))
  const source = new XMLSerializer().serializeToString(root)
  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => { resolve() }
      image.onerror = () => { reject(new Error('svg decode failed')) }
      image.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = dimensions.width
    canvas.height = dimensions.height
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('canvas unavailable')
    ctx.scale(2, 2)
    ctx.drawImage(image, 0, 0)
    const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (png === null) throw new Error('png encode failed')
    return png
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Write one blob to the clipboard as PNG; rejects where the clipboard refuses. */
async function copyPngToClipboard(png: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

/** Download one blob as a timestamped PNG file (the clipboard's fallback). */
function downloadPng(png: Blob, id: string): void {
  const anchor = document.createElement('a')
  anchor.href = URL.createObjectURL(png)
  anchor.download = `diagram-${id}.png`
  anchor.click()
  URL.revokeObjectURL(anchor.href)
}

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
  const [theme, setTheme] = useState<'dark' | 'default'>(() => activeMermaidTheme())
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyTimer = useRef<number | undefined>(undefined)
  const [zoom, setZoom] = useState(1)
  useEffect(() => () => { window.clearTimeout(copyTimer.current) }, [])

  // Theme switches re-render the diagram: the theme presenter stamps
  // `colorScheme` on the document element and `data-ds-dark-theme` on body,
  // and either attribute flip means the baked SVG colors no longer match.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme((current) => {
        const next = activeMermaidTheme()
        return next === current ? current : next
      })
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-ds-dark-theme', 'class'] })
    if (document.body !== null) {
      observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
    }
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      setRender({ phase: 'pending' })
      try {
        mermaidRef.current ??= (await import('mermaid')).default
        mermaidRef.current.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme,
          themeVariables: { background: 'transparent', fontFamily: 'inherit' },
        })
        renderIndex.current += 1
        const { svg } = await mermaidRef.current.render(`dsh-mermaid-${theme}-${renderIndex.current}`, code)
        if (!cancelled) setRender({ phase: 'ready', svg })
      } catch (error: unknown) {
        if (!cancelled) {
          setRender({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    void run()
    return () => { cancelled = true }
  }, [code, theme])

  const copyImage = (svg: string): void => {
    void (async () => {
      try {
        const png = await svgToPngBlob(svg)
        await copyPngToClipboard(png)
        setCopyState('copied')
      } catch {
        // Clipboard refusals (permissions, jsdom, insecure context) degrade
        // to a download so the image is still captured one way or another.
        setCopyState('failed')
        const png = await svgToPngBlob(svg)
        downloadPng(png, String(renderIndex.current))
      }
      copyTimer.current = window.setTimeout(() => { setCopyState('idle') }, 2000)
    })()
  }

  /** Step the zoom one notch; clamped to the [ZOOM_MIN, ZOOM_MAX] range. */
  const zoomBy = (direction: 1 | -1): void => {
    setZoom((current) => {
      const next = Math.round((current + direction * ZOOM_STEP) * 10) / 10
      return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
    })
  }

  /** Ctrl/Cmd + wheel zooms, matching the browser's own pinch gesture. */
  const onDiagramWheel = (event: WheelEvent): void => {
    if (!(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    zoomBy(event.deltaY < 0 ? 1 : -1)
  }

  if (render.phase === 'ready') {
    return (
      <div className={css.diagram} data-mermaid="ready" data-copy={copyState === 'copied' ? 'copied' : undefined}>
        <div className={css.controls}>
          <button
            type="button"
            className={css.zoomButton}
            aria-label={labels.zoomOut}
            title={labels.zoomOut}
            onClick={() => { zoomBy(-1) }}
          >
            −
          </button>
          <button
            type="button"
            className={css.zoomButton}
            aria-label={labels.resetZoom}
            title={labels.resetZoom}
            onClick={() => { setZoom(1) }}
          >
            {`${Math.round(zoom * 100)}%`}
          </button>
          <button
            type="button"
            className={css.zoomButton}
            aria-label={labels.zoomIn}
            title={labels.zoomIn}
            onClick={() => { zoomBy(1) }}
          >
            +
          </button>
          <button
            type="button"
            className={css.copyButton}
            onClick={() => { copyImage(render.svg) }}
          >
            {copyState === 'copied' ? labels.copied : labels.copyImage}
          </button>
        </div>
        <div
          className={`${css.diagramBody} ${zoom !== 1 ? css.zoomed : ''}`}
          style={zoom !== 1 ? { width: `${zoom * 100}%` } : undefined}
          onWheel={onDiagramWheel}
          // mermaid's SVG string is generated under securityLevel 'strict'
          // (text escaped), produced from the diagram grammar rather than the
          // raw model text.
          dangerouslySetInnerHTML={{ __html: render.svg }}
        />
        {copyState === 'failed' ? <p className={css.copyNote}>{labels.copiedFailed}</p> : null}
      </div>
    )
  }
  if (render.phase === 'failed') {
    return (
      <div className={css.failed} data-mermaid="failed">
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
  return <div className={css.pending} data-mermaid="pending">{labels.rendering}</div>
})
