/** Font panel store: snapshot-mirror action and the revision guard. */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SELECTION } from '../src/client/font-runtime.ts'
import { createFontRowStore } from '../src/client/font-store.ts'

describe('createFontRowStore', () => {
  it('init shape: the default selection with revision at -1', () => {
    const store = createFontRowStore().create()
    expect(store.getSnapshot()).toEqual({ ...DEFAULT_SELECTION, revision: -1 })
  })

  it('sync mirrors the selection and advances the revision', () => {
    const store = createFontRowStore().create()
    store.actions.sync({ ...DEFAULT_SELECTION, monoFont: 'menlo', monoSize: 13 }, 0)
    expect(store.getSnapshot().monoFont).toBe('menlo')
    expect(store.getSnapshot().monoSize).toBe(13)
    store.actions.sync({ ...DEFAULT_SELECTION, uiFamily: 'georgia', uiSize: 18 }, 2)
    expect(store.getSnapshot().uiFamily).toBe('georgia')
    expect(store.getSnapshot().revision).toBe(2)
  })

  it('revision guard drops stale and duplicate writes', () => {
    const store = createFontRowStore().create()
    store.actions.sync({ ...DEFAULT_SELECTION, termSize: 17 }, 3)
    store.actions.sync({ ...DEFAULT_SELECTION, termSize: 20 }, 2)
    store.actions.sync({ ...DEFAULT_SELECTION, termSize: 20 }, 3)
    expect(store.getSnapshot().termSize).toBe(17)
    expect(store.getSnapshot().revision).toBe(3)
  })
})
