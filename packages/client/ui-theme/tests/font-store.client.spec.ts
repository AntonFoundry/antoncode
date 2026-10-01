/** Font row store: snapshot-mirror action and the revision guard. */
import { describe, expect, it } from 'vitest'
import { createFontRowStore } from '../src/client/font-store.ts'

describe('createFontRowStore', () => {
  it('init shape: Monaco 15 with revision at -1', () => {
    const store = createFontRowStore().create()
    expect(store.getSnapshot()).toEqual({ monoFont: 'monaco', monoSize: 15, revision: -1 })
  })

  it('sync mirrors the selection and advances the revision', () => {
    const store = createFontRowStore().create()
    store.actions.sync('menlo', 13, 0)
    expect(store.getSnapshot()).toEqual({ monoFont: 'menlo', monoSize: 13, revision: 0 })
    store.actions.sync('sf-mono', 18, 2)
    expect(store.getSnapshot().monoFont).toBe('sf-mono')
    expect(store.getSnapshot().revision).toBe(2)
  })

  it('revision guard drops stale and duplicate writes', () => {
    const store = createFontRowStore().create()
    store.actions.sync('menlo', 13, 3)
    store.actions.sync('sf-mono', 18, 2)
    store.actions.sync('sf-mono', 18, 3)
    expect(store.getSnapshot().monoFont).toBe('menlo')
    expect(store.getSnapshot().revision).toBe(3)
  })
})
