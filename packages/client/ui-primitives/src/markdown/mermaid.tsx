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
  copySource: string
  copiedSource: string
  fullscreen: string
  exitFullscreen: string
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

/**
 * Copy text where the async Clipboard API is unavailable or refuses: a hidden
 * textarea plus the deprecated execCommand is the only synchronous fallback
 * the platform offers. Returns false when even that is rejected.
 */
function copyTextViaExecCommand(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

/** Copy diagram source text: the async API first, execCommand as fallback. */
async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator.clipboard?.writeText === 'function') {
    await navigator.clipboard.writeText(text)
    return
  }
  if (!copyTextViaExecCommand(text)) throw new Error('clipboard write rejected')
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
  const [sourceState, setSourceState] = useState<'idle' | 'copied'>('idle')
  const sourceTimer = useRef<number | undefined>(undefined)
  const cardRef = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const timers = [copyTimer, sourceTimer]
    return () => { for (const timer of timers) window.clearTimeout(timer.current) }
  }, [])

  // Track the card's fullscreen state so the toggle label follows an exit
  // made from outside the button (Esc, browser chrome).
  useEffect(() => {
    const onFullscreenChange = (): void => {
      setFullscreen(document.fullscreenElement === cardRef.current)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => { document.removeEventListener('fullscreenchange', onFullscreenChange) }
  }, [])

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

  const copySource = (source: string): void => {
    void (async () => {
      try {
        await copyTextToClipboard(source)
        setSourceState('copied')
      } catch {
        return // nothing else the platform offers; the button just stays
      }
      sourceTimer.current = window.setTimeout(() => { setSourceState('idle') }, 2000)
    })()
  }

  const toggleFullscreen = (): void => {
    const card = cardRef.current
    if (card === null) return
    if (document.fullscreenElement === card) {
      void document.exitFullscreen()
    } else {
      void card.requestFullscreen()
    }
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
      <div ref={cardRef} className={`${css.diagram} ${fullscreen ? css.fullscreen : ''}`} data-mermaid="ready" data-copy={copyState === 'copied' ? 'copied' : undefined}>
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
            onClick={() => { copySource(code) }}
          >
            {sourceState === 'copied' ? labels.copiedSource : labels.copySource}
          </button>
          <button
            type="button"
            className={css.copyButton}
            onClick={() => { copyImage(render.svg) }}
          >
            {copyState === 'copied' ? labels.copied : labels.copyImage}
          </button>
          <button
            type="button"
            className={css.copyButton}
            aria-label={fullscreen ? labels.exitFullscreen : labels.fullscreen}
            title={fullscreen ? labels.exitFullscreen : labels.fullscreen}
            onClick={toggleFullscreen}
          >
            {fullscreen ? '⤡' : '⛶'}
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
