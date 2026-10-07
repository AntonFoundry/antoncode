// @vitest-environment jsdom
// The webcam view: effect controls drive the shared store, capture failures
// render the matching overlay card with a working retry, and frame events
// fill the status line. Compositor/canvas GL work is out of jsdom's reach and
// no-ops here.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useReducer } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { CameraLease, EngineFrame } from '../src/client/engine.js'
import { createWebcamSettingsStore, type WebcamSettingsState } from '../src/client/settings.js'
import { WebcamView } from '../src/client/WebcamView.js'

afterEach(cleanup)

/** A lease stub whose frame callback the test drives manually. */
function stubLease(overrides: Partial<CameraLease> = {}): CameraLease & { emit(frame: EngineFrame): void } {
  let emit: ((frame: EngineFrame) => void) | undefined
  return {
    video: document.createElement('video'),
    onFrame: (cb) => { emit = cb; return () => { emit = undefined } },
    enableSegmentation: () => () => {},
    refreshDevices: async () => [],
    release: () => {},
    emit: (frame) => { emit?.(frame) },
    ...overrides,
  } as CameraLease & { emit(frame: EngineFrame): void }
}

/**
 * A stand-in for the framework-bound `useStore` hook: subscribes to the store
 * so store writes re-render the view exactly as the renderer's bound hook
 * does in production. Without the subscription the component would render
 * once and the dock would never track effect changes.
 */
function useStoreLike(
  store: { getSnapshot(): WebcamSettingsState; subscribe(cb: () => void): () => void },
): SnapshotSelectorHook<WebcamSettingsState> {
  return (sel) => {
    const [, force] = useReducer((c: number): number => c + 1, 0)
    useEffect(() => store.subscribe(force), [store, force])
    return sel(store.getSnapshot())
  }
}

function viewSetup() {
  const store = createWebcamSettingsStore().create()
  const useSettings = useStoreLike(store)
  const lease = stubLease()
  const acquire = vi.fn(async (_deviceId: string | undefined) => lease)
  const props = {
    acquire,
    settingsActions: store.actions,
    themeTokens: () => ({}),
    useSettings,
  }
  return { store, lease, acquire, props }
}

describe('WebcamView', () => {
  it('renders the effect dock and drives the shared store from the segmented control', async () => {
    const { props, store } = viewSetup()
    render(<WebcamView {...props} />)
    expect(screen.getByText('Raw')).toBeDefined()
    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(store.getSnapshot().effect).toBe('remove'))
    fireEvent.click(screen.getByText('Replace'))
    await waitFor(() => expect(store.getSnapshot().effect).toBe('replace'))
  })

  it('shows remove-style and replace backdrops only for their effects; slider rides blur', async () => {
    const { props, store } = viewSetup()
    render(<WebcamView {...props} />)
    expect(screen.queryByText('Green')).toBeNull()
    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(screen.getByText('Green')).toBeDefined())
    fireEvent.click(screen.getByText('Green'))
    await waitFor(() => expect(store.getSnapshot().removeStyle).toBe('green'))
    fireEvent.click(screen.getByText('Blur'))
    await waitFor(() => expect(screen.getByText('Strength')).toBeDefined())
    fireEvent.change(screen.getByRole('slider'), { target: { value: '80' } })
    await waitFor(() => expect(store.getSnapshot().blurStrength).toBe(80))
  })

  it('mirrors the toggle into the store and lists devices into the picker', async () => {
    const { props, store, lease } = viewSetup()
    ;(lease.refreshDevices as ReturnType<typeof vi.fn>) = vi.fn(async () => [
      { deviceId: 'cam-1', kind: 'videoinput', label: 'External Cam', groupId: 'g', toJSON: () => ({}) },
    ] as MediaDeviceInfo[])
    render(<WebcamView {...props} />)
    fireEvent.click(screen.getByTitle('Mirror'))
    await waitFor(() => expect(store.getSnapshot().mirror).toBe(false))
    await waitFor(() => expect(screen.getByText('External Cam')).toBeDefined())
  })

  it('renders the permission card on denial and retry re-acquires', async () => {
    const acquire = vi.fn()
      .mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
      .mockResolvedValueOnce(stubLease())
    const store = createWebcamSettingsStore().create()
    render(
      <WebcamView
        acquire={acquire}
        settingsActions={store.actions}
        themeTokens={() => ({})}
        useSettings={sel => sel(store.getSnapshot())}
      />,
    )
    await waitFor(() => expect(screen.getByText('Camera access denied')).toBeDefined())
    expect(screen.getByText(/Allow camera access/)).toBeDefined()
    fireEvent.click(screen.getByText('Retry'))
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('Camera access denied')).toBeNull())
  })

  it('fills the status line from frame events', async () => {
    const { props, lease } = viewSetup()
    render(<WebcamView {...props} />)
    await waitFor(() => expect(acquireCalls(props)).toBe(1))
    // jsdom's videoWidth/videoHeight are getter-only — defineProperty, not
    // Object.assign.
    const video = document.createElement('video')
    Object.defineProperty(video, 'videoWidth', { value: 1280 })
    Object.defineProperty(video, 'videoHeight', { value: 720 })
    lease.emit({
      frameId: 1,
      video,
      mask: undefined,
      fps: 30,
      delegate: 'GPU',
    })
    await waitFor(() => expect(screen.getByText('30 fps')).toBeDefined())
    expect(screen.getByText('1280×720')).toBeDefined()
    expect(screen.getByText('GPU')).toBeDefined()
  })

  it('shows the segmentation-health issue from frame events and clears it on recovery', async () => {
    const { props, lease } = viewSetup()
    render(<WebcamView {...props} />)
    await waitFor(() => expect(acquireCalls(props)).toBe(1))
    const video = document.createElement('video')
    Object.defineProperty(video, 'videoWidth', { value: 640 })
    Object.defineProperty(video, 'videoHeight', { value: 480 })
    lease.emit({
      frameId: 1,
      video,
      mask: undefined,
      fps: 12,
      delegate: 'CPU',
      segmenterIssue: '12 dropped · Graph has errors',
    })
    await waitFor(() => expect(screen.getByText(/12 dropped/)).toBeDefined())
    lease.emit({
      frameId: 2,
      video,
      mask: undefined,
      fps: 12,
      delegate: 'CPU',
      segmenterIssue: undefined,
    })
    await waitFor(() => expect(screen.queryByText(/12 dropped/)).toBeNull())
  })
})

/** Acquire call count reader (the spy identity is per-setup). */
function acquireCalls(props: { acquire: ReturnType<typeof vi.fn> }): number {
  return props.acquire.mock.calls.length
}
