/** Disposable IndexedDB history, isolated per test without browser-global mutation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionAddress, SessionHistoryRecord, SessionWireHeader } from '../src/types.ts'
import { entries, ev } from './event-script.client.ts'
import { createSessionHistoryCache, type SessionHistoryCache } from '../src/client/history-cache.ts'

const address: SessionAddress = { kind: 'session', sessionId: SessionId('browser-history') }
const header: SessionWireHeader = { id: SessionId('browser-history'), createdAt: 100, version: SESSION_FORMAT_VERSION, isSeeded: false }
function record(seq: number): SessionHistoryRecord {
  const [item] = entries([ev.turnStart(SessionSeq(seq), seq + 1)])
  if (item === undefined) throw new Error('Expected one history record')
  return item
}

const caches: SessionHistoryCache[] = []
afterEach(async () => { await Promise.all(caches.splice(0).map(cache => cache.close())); vi.restoreAllMocks() })
function cache(factory = new IDBFactory(), namespace = '/account'): SessionHistoryCache {
  const value = createSessionHistoryCache(namespace, factory, IDBKeyRange)
  if (value === undefined) throw new Error('Test database unavailable')
  caches.push(value)
  return value
}

describe('browser history cache', () => {
  it('stores committed events incrementally and retains the newest window across stale tab writes', async () => {
    const store = cache()
    await store.replace(address, { header, cursor: 1, records: [record(0), record(1)], hasMore: false })
    await store.append(address, header, [record(2)])
    await store.append(address, header, [record(1), record(2), record(4)])
    await store.replace(address, { header, cursor: 0, records: [record(0)], hasMore: false })
    expect(await store.read(address)).toEqual({ header, cursor: 2, records: [record(0), record(1), record(2)], hasMore: false })
  })

  it('keeps older pages locally without dropping newer messages', async () => {
    const store = cache()
    await store.replace(address, { header, cursor: 2, records: [record(2)], hasMore: true })
    await store.append(address, header, [record(3)])
    await store.prepend(address, header, [record(0), record(1)], false)
    expect(await store.read(address)).toEqual({
      header, cursor: 3, records: [record(0), record(1), record(2), record(3)], hasMore: false,
    })
  })

  it('isolates accounts and discards stale writes after a Session identity changes', async () => {
    const factory = new IDBFactory()
    const first = cache(factory, '/first'), second = cache(factory, '/second')
    await first.replace(address, { header, cursor: 1, records: [record(0), record(1)], hasMore: false })
    expect(await second.read(address)).toBeUndefined()
    const next = { ...header, createdAt: 200 }
    await first.replace(address, { header: next, cursor: 0, records: [record(0)], hasMore: false })
    await first.append(address, header, [record(1)])
    expect(await first.read(address)).toEqual({ header: next, cursor: 0, records: [record(0)], hasMore: false })
    await first.remove(address)
    expect(await first.read(address)).toBeUndefined()
  })

  it('reopens an empty database after browser data is cleared', async () => {
    const factory = new IDBFactory(), first = cache(factory)
    await first.replace(address, { header, cursor: 0, records: [record(0)], hasMore: false })
    await first.close()
    await new Promise<void>((resolve, reject) => {
      const deletion = factory.deleteDatabase('dsh-session-history')
      deletion.onsuccess = () => { resolve() }; deletion.onerror = () => { reject(new Error('Database deletion failed', { cause: deletion.error })) }
    })
    expect(await cache(factory).read(address)).toBeUndefined()
  })

  it('rejects and removes a discontinuous stored window', async () => {
    const factory = new IDBFactory(), store = cache(factory)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await store.replace(address, { header, cursor: 1, records: [record(0), record(1)], hasMore: false })
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('dsh-session-history', 1)
      request.onsuccess = () => { resolve(request.result) }; request.onerror = () => { reject(new Error('Database opening failed', { cause: request.error })) }
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('events', 'readwrite')
        const events = tx.objectStore('events')
        const keys = events.getAllKeys()
        keys.onsuccess = () => {
          const last = keys.result.at(-1)
          if (last !== undefined) events.delete(last)
        }
        tx.oncomplete = () => { resolve() }; tx.onerror = () => { reject(new Error('Database transaction failed', { cause: tx.error })) }
      })
      expect(await store.read(address)).toBeUndefined()
      expect(await store.read(address)).toBeUndefined()
      expect(warning).toHaveBeenCalledTimes(1)
    } finally { db.close() }
  })

  it('continues without persistence when the browser refuses storage', async () => {
    const factory = new IDBFactory()
    vi.spyOn(factory, 'open').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError') })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = cache(factory)
    expect(await store.read(address)).toBeUndefined()
    await store.replace(address, { header, cursor: 0, records: [record(0)], hasMore: false })
    expect(warning).toHaveBeenCalledTimes(1)
  })
})
