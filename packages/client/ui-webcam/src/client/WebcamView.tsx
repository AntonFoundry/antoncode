/**
 * The webcam view: one live, GPU-composited camera surface per buffer leaf.
 * Owns one capture lease (refcounted by the shared engine) and one compositor
 * per canvas; draws engine frames on a rAF loop, and renders the effect
 * controls bound to the shared settings store. Permission, device-absence,
 * and model-failure states render as overlay cards instead of a dead canvas.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BakedActions, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { BACKDROPS, backdropCss } from './backdrops.js'
import { createCompositor, type Compositor } from './compositor.js'
import type { CameraLease, EngineFrame } from './engine.js'
import { renderParams } from './params.js'
import type { WebcamEffect, WebcamSettingsActions, WebcamSettingsState } from './settings.js'
import css from './WebcamView.module.css'

const EFFECT_LABELS: readonly { id: WebcamEffect; label: string }[] = [
  { id: 'off', label: 'Raw' },
  { id: 'remove', label: 'Remove' },
  { id: 'blur', label: 'Blur' },
  { id: 'replace', label: 'Replace' },
]

/** Overlay failure the view renders instead of the canvas. */
interface ViewError {
  kind: 'denied' | 'unavailable' | 'error'
  message?: string
}

/** The write face of the shared settings store: bound (draft-applied) actions. */
export type SettingsActions = BakedActions<WebcamSettingsState, WebcamSettingsActions>

/** Faces injected by the plugin's apply (the engine lives in the apply closure). */
export interface WebcamViewProps {
  /** Acquire one capture lease, optionally pinned to a device id. */
  acquire(deviceId: string | undefined): Promise<CameraLease>
  /** The shared settings store's bound actions. */
  settingsActions: SettingsActions
  /** The loaded theme's alias tokens (accent for the active controls). */
  themeTokens(): Record<string, string>
  /** Settings store read hook (bound from the hooks compartment). */
  useSettings: SnapshotSelectorHook<WebcamSettingsState>
}

/** Classify an acquire failure for the overlay card.
 * @param caught - the thrown value.
 * @returns the overlay error.
 */
function classifyError(caught: unknown): ViewError {
  const name = caught instanceof DOMException ? caught.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return { kind: 'denied' }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { kind: 'unavailable' }
  return { kind: 'error', message: caught instanceof Error ? caught.message : String(caught) }
}

/**
 * Render the live webcam surface for one buffer leaf.
 * @param props - the injected engine faces and the settings store hook.
 * @returns the webcam element tree.
 */
export function WebcamView(props: WebcamViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const leaseRef = useRef<CameraLease | null>(null)
  const compositorRef = useRef<Compositor | null>(null)
  const frameRef = useRef<EngineFrame | null>(null)
  const releaseSegRef = useRef<(() => void) | null>(null)
  const rafRef = useRef<number | undefined>(undefined)
  const settingsRef = useRef(props.useSettings(s => s))
  settingsRef.current = props.useSettings(s => s)
  const paramsRef = useRef(renderParams(settingsRef.current))

  // Frame-driven display facts land in state only when the displayed value
  // actually changes; the refs carry the previous values for that guard.
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<ViewError | undefined>(undefined)
  const [devices, setDevices] = useState<readonly MediaDeviceInfo[]>([])
  const [fps, setFps] = useState(0)
  const [dims, setDims] = useState('')
  const [delegate, setDelegate] = useState<string | undefined>(undefined)
  const [segIssue, setSegIssue] = useState<string | undefined>(undefined)
  const [backdropImage, setBackdropImage] = useState<ImageBitmap | undefined>(undefined)
  const fpsGuard = useRef(0)
  const dimsGuard = useRef('')
  const delegateGuard = useRef<string | undefined>(undefined)
  const issueGuard = useRef<string | undefined>(undefined)

  const settings = props.useSettings(s => s)
  paramsRef.current = renderParams(settings)

  /** Start/stop the engine's segmentation request to match the active effect. */
  const syncSegmentation = useCallback((): void => {
    const lease = leaseRef.current
    if (lease === null) return
    if (settingsRef.current.effect === 'off') {
      releaseSegRef.current?.()
      releaseSegRef.current = null
      return
    }
    releaseSegRef.current ??= lease.enableSegmentation()
  }, [])

  useEffect(() => {
    let disposed = false
    let frameOff: (() => void) | undefined
    setError(undefined)
    void (async () => {
      let lease: CameraLease
      try {
        lease = await props.acquire(settingsRef.current.deviceId)
      } catch (caught) {
        if (disposed) return
        setError(classifyError(caught))
        return
      }
      if (disposed) { lease.release(); return }
      leaseRef.current = lease
      frameOff = lease.onFrame((frame) => {
        frameRef.current = frame
        if (frame.fps !== fpsGuard.current) { fpsGuard.current = frame.fps; setFps(frame.fps) }
        const next = frame.video.videoWidth > 0 ? `${frame.video.videoWidth}×${frame.video.videoHeight}` : ''
        if (next !== dimsGuard.current) { dimsGuard.current = next; setDims(next) }
        if (frame.delegate !== delegateGuard.current) { delegateGuard.current = frame.delegate; setDelegate(frame.delegate) }
        if (frame.segmenterIssue !== issueGuard.current) { issueGuard.current = frame.segmenterIssue; setSegIssue(frame.segmenterIssue) }
      })
      const canvas = canvasRef.current
      if (canvas !== null) compositorRef.current = createCompositor(canvas) ?? null
      try { setDevices(await lease.refreshDevices()) } catch { /* the picker falls back to the default entry */ }
      syncSegmentation()
      const draw = (): void => {
        rafRef.current = requestAnimationFrame(draw)
        const comp = compositorRef.current
        const frame = frameRef.current
        const target = canvasRef.current
        if (comp === null || frame === null || target === null) return
        const vw = frame.video.videoWidth
        const vh = frame.video.videoHeight
        if (vw === 0 || vh === 0) return
        if (target.width !== vw) target.width = vw
        if (target.height !== vh) target.height = vh
        try {
          comp.render(frame.video, paramsRef.current, frame.mask)
        } catch { /* a dropped composite frame keeps the last painted one */ }
      }
      rafRef.current = requestAnimationFrame(draw)
    })()
    return () => {
      disposed = true
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
      rafRef.current = undefined
      frameOff?.()
      releaseSegRef.current?.()
      releaseSegRef.current = null
      leaseRef.current?.release()
      leaseRef.current = null
      compositorRef.current?.dispose()
      compositorRef.current = null
      frameRef.current = null
    }
    // One capture lifecycle per device selection / retry attempt.
  }, [props.acquire, settingsRef.current.deviceId, attempt, syncSegmentation])

  useEffect(() => { syncSegmentation() }, [settings.effect, syncSegmentation])

  useEffect(() => {
    compositorRef.current?.setBackdropImage(backdropImage)
  }, [backdropImage])

  const tokens = props.themeTokens()
  const accentStyle = useMemo(() => ({
    '--wc-accent': tokens['--dsw-alias-brand-primary'] ?? '#4d78cc',
    '--wc-panel': tokens['--dsw-alias-bg-base'] ?? '#16181d',
  }), [tokens]) as React.CSSProperties

  const pickCustom = useCallback((file: File | undefined): void => {
    if (file === undefined) return
    createImageBitmap(file).then((bitmap) => {
      setBackdropImage(bitmap)
    }).catch(() => { /* undecodable file: keep the previous backdrop */ })
  }, [])

  return (
    <div className={css.host} style={accentStyle} data-webcam-view>
      <canvas ref={canvasRef} className={css.canvas} />
      {error !== undefined && (
        <div className={css.overlay}>
          <div className={css.card}>
            <div className={css.cardTitle}>
              {error.kind === 'denied' ? 'Camera access denied' : error.kind === 'unavailable' ? 'No camera found' : 'Camera failed to start'}
            </div>
            <div className={css.cardBody}>
              {error.kind === 'denied'
                ? 'Allow camera access for this app in System Settings and the browser, then retry. Opening the GUI in a browser also works for this view.'
                : error.kind === 'unavailable'
                  ? 'No camera device found. Connect one, then retry.'
                  : error.message ?? 'Unknown error — retry.'}
            </div>
            <button type="button" className={css.primaryButton} onClick={() => { setAttempt(a => a + 1) }}>Retry</button>
          </div>
        </div>
      )}
      {error === undefined && (
        <div className={css.dock}>
          <div className={css.row}>
            <div className={css.segmented}>
              {EFFECT_LABELS.map(({ id, label }) => (
                <button
                  key={id} type="button" className={css.segment}
                  data-active={settings.effect === id || undefined}
                  onClick={() => { props.settingsActions.setEffect(id) }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className={css.spacer} />
            <button
              type="button" className={css.iconButton} title="Mirror"
              data-active={settings.mirror || undefined}
              onClick={() => { props.settingsActions.toggleMirror() }}
            >⇋</button>
            <select
              className={css.select}
              value={settings.deviceId ?? ''}
              onChange={(event) => { props.settingsActions.setDeviceId(event.target.value === '' ? undefined : event.target.value) }}
            >
              <option value="">Default camera</option>
              {devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Camera'}</option>)}
            </select>
          </div>
          {settings.effect === 'blur' && (
            <div className={css.row}>
              <span className={css.hint}>Strength</span>
              <input
                type="range" min={0} max={100} className={css.slider}
                value={settings.blurStrength}
                onChange={(event) => { props.settingsActions.setBlurStrength(Number(event.target.value)) }}
              />
            </div>
          )}
          {settings.effect === 'remove' && (
            <div className={css.row}>
              <span className={css.hint}>Background</span>
              <button
                type="button" className={css.swatch} data-active={settings.removeStyle === 'studio' || undefined}
                style={{ background: 'linear-gradient(to bottom, #33373f, #1a1d24)' }}
                onClick={() => { props.settingsActions.setRemoveStyle('studio') }}
              >Studio</button>
              <button
                type="button" className={css.swatch} data-active={settings.removeStyle === 'green' || undefined}
                style={{ background: 'linear-gradient(to bottom, #00c540, #00b140)' }}
                onClick={() => { props.settingsActions.setRemoveStyle('green') }}
              >Green</button>
            </div>
          )}
          {settings.effect === 'replace' && (
            <div className={css.row}>
              <span className={css.hint}>Background</span>
              {BACKDROPS.map((backdrop, index) => (
                <button
                  key={backdrop.id} type="button" className={css.swatch}
                  title={backdrop.label}
                  data-active={settings.backdropIndex === index || undefined}
                  style={{ background: backdropCss(backdrop) }}
                  onClick={() => { props.settingsActions.setBackdropIndex(index) }}
                />
              ))}
              <label className={css.customLabel}>
                {backdropImage !== undefined ? 'Image selected' : 'Custom…'}
                <input
                  type="file" accept="image/*" className={css.fileInput}
                  onChange={(event) => {
                    pickCustom(event.target.files?.[0])
                    props.settingsActions.setBackdropIndex(BACKDROPS.length)
                  }}
                />
              </label>
            </div>
          )}
          <div className={css.statusRow}>
            <span>{fps} fps</span>
            <span>{dims}</span>
            {delegate !== undefined && <span>{delegate === 'GPU' ? 'GPU' : 'CPU'}</span>}
            {segIssue !== undefined && <span role="status">{segIssue}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
