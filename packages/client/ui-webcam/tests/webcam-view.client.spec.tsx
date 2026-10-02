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
    expect(screen.getByText('原始')).toBeDefined()
    fireEvent.click(screen.getByText('移除'))
    await waitFor(() => expect(store.getSnapshot().effect).toBe('remove'))
    fireEvent.click(screen.getByText('替换'))
    await waitFor(() => expect(store.getSnapshot().effect).toBe('replace'))
  })

  it('shows remove-style and replace backdrops only for their effects; slider rides blur', async () => {
    const { props, store } = viewSetup()
    render(<WebcamView {...props} />)
    expect(screen.queryByText('绿幕')).toBeNull()
    fireEvent.click(screen.getByText('移除'))
    await waitFor(() => expect(screen.getByText('绿幕')).toBeDefined())
    fireEvent.click(screen.getByText('绿幕'))
    await waitFor(() => expect(store.getSnapshot().removeStyle).toBe('green'))
    fireEvent.click(screen.getByText('模糊'))
    await waitFor(() => expect(screen.getByText('强度')).toBeDefined())
    fireEvent.change(screen.getByRole('slider'), { target: { value: '80' } })
    await waitFor(() => expect(store.getSnapshot().blurStrength).toBe(80))
  })

  it('mirrors the toggle into the store and lists devices into the picker', async () => {
    const { props, store, lease } = viewSetup()
    ;(lease.refreshDevices as ReturnType<typeof vi.fn>) = vi.fn(async () => [
      { deviceId: 'cam-1', kind: 'videoinput', label: 'External Cam', groupId: 'g', toJSON: () => ({}) },
    ] as MediaDeviceInfo[])
    render(<WebcamView {...props} />)
    fireEvent.click(screen.getByTitle('镜像'))
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
    await waitFor(() => expect(screen.getByText('相机权限被拒绝')).toBeDefined())
    expect(screen.getByText(/浏览器设置中允许/)).toBeDefined()
    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('相机权限被拒绝')).toBeNull())
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
})

/** Acquire call count reader (the spy identity is per-setup). */
function acquireCalls(props: { acquire: ReturnType<typeof vi.fn> }): number {
  return props.acquire.mock.calls.length
}
