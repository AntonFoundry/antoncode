// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { cleanup, render, waitFor, fireEvent } from '@testing-library/react'
import type { LangflowActions } from '../src/client/langflow.tsx'
import { LangflowView } from '../src/client/langflow.tsx'
import type { LangflowInjected } from '../src/client/langflow.tsx'
import { en, NS, zh } from '../src/client/locales.ts'

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

afterEach(cleanup)

function face(actions: LangflowActions): LangflowInjected {
  return { labels: { t }, actions }
}

function view(actions: LangflowActions): ReturnType<typeof render> {
  return render(createElement(LangflowView, face(actions) as never))
}

describe('LangflowView', () => {
  it('snapshots the sidecar on mount and renders the iframe while running', async () => {
    const actions: LangflowActions = {
      status: vi.fn(async () => ({ state: 'running', url: 'http://127.0.0.1:7860/' })),
      start: vi.fn(),
      stop: vi.fn(),
    }
    const { container, getByTitle } = view(actions)
    await waitFor(() => expect(getByTitle('LangFlow')).toBeDefined())
    const frame = container.querySelector('iframe')
    expect(frame?.getAttribute('src')).toBe('http://127.0.0.1:7860/')
    expect(container.textContent).toContain(t('langflow.state.running'))
    expect(container.textContent).toContain(t('langflow.open'))
  })

  it('shows the stopped placeholder with the hint while stopped', async () => {
    const actions: LangflowActions = {
      status: vi.fn(async () => ({ state: 'stopped' })),
      start: vi.fn(),
      stop: vi.fn(),
    }
    const { container } = view(actions)
    await waitFor(() => expect(actions.status).toHaveBeenCalled())
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain(t('langflow.stopped.hint'))
    expect(container.textContent).toContain(t('langflow.state.stopped'))
  })

  it('start renders the starting pill immediately, then the running embed at readiness', async () => {
    let resolveStart: ((status: { state: 'running'; url: string }) => void) | undefined
    const actions: LangflowActions = {
      status: vi.fn(async () => ({ state: 'stopped' })),
      start: vi.fn(() => new Promise((resolve) => {
        resolveStart = resolve
      })),
      stop: vi.fn(),
    }
    const { container, getByText } = view(actions)
    await waitFor(() => expect(actions.status).toHaveBeenCalled())
    fireEvent.click(getByText(t('langflow.start')))
    expect(actions.start).toHaveBeenCalled()
    expect(container.textContent).toContain(t('langflow.state.starting'))
    resolveStart?.({ state: 'running', url: 'http://127.0.0.1:7860/' })
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(container.textContent).toContain(t('langflow.state.running'))
  })

  it('stop tears down to the stopped placeholder', async () => {
    const actions: LangflowActions = {
      status: vi.fn(async () => ({ state: 'running', url: 'http://127.0.0.1:7860/' })),
      start: vi.fn(),
      stop: vi.fn(async () => ({ state: 'stopped' })),
    }
    const { container, getByText } = view(actions)
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    fireEvent.click(getByText(t('langflow.stop')))
    await waitFor(() => expect(container.querySelector('iframe')).toBeNull())
    expect(container.textContent).toContain(t('langflow.state.stopped'))
  })

  it('renders a startup failure from the sidecar in the placeholder', async () => {
    const actions: LangflowActions = {
      status: vi.fn(async () => ({ state: 'error', error: 'langflow exited (code 1) before readiness: boom' })),
      start: vi.fn(),
      stop: vi.fn(),
    }
    const { container } = view(actions)
    await waitFor(() => expect(container.textContent).toContain('boom'))
    expect(container.textContent).toContain(t('langflow.state.error'))
  })

  it('keeps both dictionaries in sync with the key set', () => {
    const keys = Object.keys(zh).sort()
    expect(Object.keys(en).sort()).toEqual(keys)
    expect(keys).toContain('view.dagflow')
  })
})

describe('flowbuilder locale namespace', () => {
  it('registers under its own namespace', () => {
    expect(NS).toBe('flowbuilder')
  })
})
