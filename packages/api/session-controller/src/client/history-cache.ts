/** Origin-local disposable history records; the Host remains the durable authority. */
import type { SessionAddress, SessionHistoryRecord, SessionWireHeader } from '../types.ts'
import { assertSessionWireEvent } from './session-wire-event.ts'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session/types'

/** One validated contiguous durable history window. Transient model chunks are never persisted. */
export interface CachedSessionHistory {
  readonly header: SessionWireHeader
  readonly cursor: number
  readonly records: readonly SessionHistoryRecord[]
  readonly hasMore: boolean
}

/** Browser storage owned by one authenticated Client root. */
export interface SessionHistoryCache {
  /**
   * Read the latest contiguous window, or undefined when storage has no usable copy.
   * @param address - durable Session address.
   * @returns the validated cached window, or undefined.
   */
  read(this: void, address: SessionAddress): Promise<CachedSessionHistory | undefined>
  /**
   * Atomically replace an opening window and its identity.
   * @param address - durable Session address.
   * @param history - complete Host-confirmed opening window.
   * @returns when the cache write finishes or storage is unavailable.
   */
  replace(this: void, address: SessionAddress, history: CachedSessionHistory): Promise<void>
  /**
   * Persist only new committed events after the stored cursor.
   * @param address - durable Session address.
   * @param header - identity whose prefix the events extend.
   * @param records - ordered committed increments.
   * @returns when the cache write finishes or storage is unavailable.
   */
  append(this: void, address: SessionAddress, header: SessionWireHeader, records: readonly SessionHistoryRecord[]): Promise<void>
  /**
   * Retain an older contiguous page already read from the Host.
   * @param address - durable Session address.
   * @param header - identity whose prefix the page extends.
   * @param records - ordered older records adjoining the cached window.
   * @param hasMore - whether the Host reports still earlier history.
   * @returns when the cache write finishes or storage is unavailable.
   */
  prepend(this: void, address: SessionAddress, header: SessionWireHeader,
    records: readonly SessionHistoryRecord[], hasMore: boolean): Promise<void>
  /**
   * Remove a deleted or rejected Session's local copy.
   * @param address - durable Session address.
   * @returns when deletion finishes or storage is unavailable.
   */
  remove(this: void, address: SessionAddress): Promise<void>
  /**
   * Release the database connection after outstanding transactions finish.
   * @returns completed disposal.
   */
  close(this: void): Promise<void>
}

interface HistoryMetadata {
  key: string
  header: SessionWireHeader
  cursor: number
  firstSeq: number
  hasMore: boolean
}
interface StoredEvent {
  key: string
  seq: number
  record: SessionHistoryRecord
}

/**
 * Check that a transport window reaches its declared cursor without gaps.
 * @param records - ordered durable records from the cache or Host.
 * @param cursor - inclusive final durable sequence.
 */
export function assertHistoryCursor(records: readonly SessionHistoryRecord[], cursor: number): void {
  let next = records[0]?.event.seq ?? cursor + 1
  for (const record of records) {
    if (record.event.seq !== next++) throw new Error('Discontinuous Session history window')
  }
  if (next !== cursor + 1) throw new Error('Incomplete Session history window')
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(new Error('Browser history request failed', { cause: request.error })) }
  })
}

function completed(transaction: IDBTransaction): Promise<void> {
  const completion = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => { resolve() }
    transaction.onabort = () => { reject(transaction.error ?? new Error('History cache transaction aborted')) }
    transaction.onerror = () => { reject(new Error('Browser history transaction failed', { cause: transaction.error })) }
  })
  // Request rejection can return control before the transaction also aborts.
  void completion.catch((_error: unknown) => { /* the owning operation reports the request or transaction failure */ })
  return completion
}


function metadata(value: unknown, key: string): HistoryMetadata | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const rawHeader = row['header']
  if (typeof rawHeader !== 'object' || rawHeader === null) return undefined
  const header = rawHeader as Record<string, unknown>
  const cursor = row['cursor'], firstSeq = row['firstSeq']
  const id = header['id'], createdAt = header['createdAt'], isSeeded = header['isSeeded']
  if (row['key'] !== key || typeof id !== 'string' || typeof createdAt !== 'number'
    || !Number.isSafeInteger(createdAt) || createdAt < 0
    || header['version'] !== SESSION_FORMAT_VERSION || typeof isSeeded !== 'boolean'
    || typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < -1
    || typeof firstSeq !== 'number' || !Number.isSafeInteger(firstSeq) || firstSeq < 0
    || firstSeq > cursor + 1 || row['hasMore'] !== (firstSeq > 0)) return undefined
  return { key, header: { id: SessionId(id), createdAt, version: SESSION_FORMAT_VERSION, isSeeded },
    cursor, firstSeq, hasMore: firstSeq > 0 }
}

function recordsOf(values: readonly unknown[], row: HistoryMetadata): SessionHistoryRecord[] {
  const records: SessionHistoryRecord[] = []
  let expected = row.firstSeq
  for (const value of values) {
    if (typeof value !== 'object' || value === null) throw new Error('Invalid browser history record')
    const stored = value as Partial<StoredEvent>
    if (stored.key !== row.key || stored.seq !== expected || stored.record?.type !== 'event') {
      throw new Error('Discontinuous browser history')
    }
    assertSessionWireEvent(stored.record.event)
    if (stored.record.event.seq !== expected) throw new Error('Browser history cursor mismatch')
    records.push(stored.record)
    expected++
  }
  if (expected !== row.cursor + 1) throw new Error('Incomplete browser history')
  return records
}

/**
 * Open an IndexedDB cache isolated by browser origin and Host account home.
 * @param namespace - authenticated Host home identifying the local account.
 * @param providedFactory - browser database factory; omitted when the runtime has no IndexedDB.
 * @param providedRanges - browser key-range constructor paired with the factory.
 * @returns a disposable cache, or undefined when browser persistence is unavailable.
 */
export function createSessionHistoryCache(
  namespace: string | (() => string | undefined),
  providedFactory?: IDBFactory,
  providedRanges?: Pick<typeof IDBKeyRange, 'bound'>,
): SessionHistoryCache | undefined {
  const factory = providedFactory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB)
  const ranges = providedRanges ?? (typeof IDBKeyRange === 'undefined' ? undefined : IDBKeyRange)
  if (factory === undefined || ranges === undefined) return undefined
  const eventRange = (key: string): IDBKeyRange => ranges.bound([key, 0], [key, Number.MAX_SAFE_INTEGER])
  let database: Promise<IDBDatabase> | undefined
  let closed = false
  let warned = false
  const pending = new Set<Promise<unknown>>()
  const keyOf = (address: SessionAddress): string => {
    const owner = typeof namespace === 'string' ? namespace : namespace()
    if (owner === undefined) throw new Error('History cache awaits an authenticated Host')
    return JSON.stringify([owner, address])
  }
  const open = (): Promise<IDBDatabase> => {
    if (closed) return Promise.reject(new Error('History cache closed'))
    database ??= new Promise((resolve, reject) => {
      const request = factory.open('dsh-session-history', 1)
      let blocked = false
      request.onupgradeneeded = () => {
        const db = request.result
        db.createObjectStore('sessions', { keyPath: 'key' })
        db.createObjectStore('events', { keyPath: ['key', 'seq'] })
      }
      request.onerror = () => { reject(new Error('Browser history request failed', { cause: request.error })) }
      request.onblocked = () => { blocked = true; reject(new Error('History cache upgrade is blocked')) }
      request.onsuccess = () => {
        const db = request.result
        if (closed || blocked) { db.close(); reject(new Error('History cache closed')); return }
        db.onversionchange = () => { db.close(); database = undefined }
        resolve(db)
      }
    })
    return database
  }
  const attempt = <T>(operation: () => Promise<T>, fallback: T): Promise<T> => {
    if (closed) return Promise.resolve(fallback)
    const task = operation().catch((error: unknown) => {
      if (!closed && !warned) { warned = true; console.warn('[session-controller] Browser history cache unavailable; using Host history.', error) }
      return fallback
    })
    pending.add(task)
    void task.then(() => { pending.delete(task) })
    return task
  }
  const remove = (address: SessionAddress): Promise<void> => attempt(async () => {
    const db = await open(); const tx = db.transaction(['sessions', 'events'], 'readwrite'); const done = completed(tx)
    const key = keyOf(address)
    tx.objectStore('sessions').delete(key); tx.objectStore('events').delete(eventRange(key)); await done
  }, undefined)
  return {
    read: address => attempt(async () => {
      const db = await open(); const key = keyOf(address)
      const tx = db.transaction(['sessions', 'events'], 'readonly'); const done = completed(tx)
      const [raw, values] = await Promise.all([
        result<unknown>(tx.objectStore('sessions').get(key)),
        result<unknown[]>(tx.objectStore('events').getAll(eventRange(key))),
      ])
      await done
      const row = metadata(raw, key)
      if (row === undefined) return undefined
      const id = address.kind === 'session' ? address.sessionId : address.childSessionId
      if (row.header.id !== id) { await remove(address); return undefined }
      try { return { header: row.header, cursor: row.cursor, records: recordsOf(values, row), hasMore: row.hasMore } }
      catch (error: unknown) { await remove(address); throw error }
    }, undefined),
    replace: (address, history) => attempt(async () => {
      const db = await open(); const key = keyOf(address)
      const tx = db.transaction(['sessions', 'events'], 'readwrite'); const done = completed(tx)
      const sessions = tx.objectStore('sessions'); const events = tx.objectStore('events')
      const old = metadata(await result<unknown>(sessions.get(key)), key)
      if (old !== undefined && old.header.createdAt === history.header.createdAt
        && old.header.version === history.header.version && old.cursor > history.cursor) { await done; return }
      events.delete(eventRange(key))
      for (const record of history.records) events.put({ key, seq: record.event.seq, record } satisfies StoredEvent)
      sessions.put({ key, header: history.header, cursor: history.cursor,
        firstSeq: history.records[0]?.event.seq ?? history.cursor + 1, hasMore: history.hasMore } satisfies HistoryMetadata)
      await done
    }, undefined),
    append: (address, header, records) => attempt(async () => {
      if (records.length === 0) return
      const db = await open(); const key = keyOf(address)
      const tx = db.transaction(['sessions', 'events'], 'readwrite'); const done = completed(tx)
      const sessions = tx.objectStore('sessions'); const events = tx.objectStore('events')
      const row = metadata(await result<unknown>(sessions.get(key)), key)
      if (row === undefined || row.header.createdAt !== header.createdAt || row.header.version !== header.version) { await done; return }
      for (const record of records) {
        if (record.event.seq <= row.cursor) continue
        if (record.event.seq !== row.cursor + 1) break
        events.put({ key, seq: record.event.seq, record } satisfies StoredEvent)
        row.cursor = record.event.seq
      }
      sessions.put(row); await done
    }, undefined),
    prepend: (address, header, records, hasMore) => attempt(async () => {
      const first = records[0]
      if (first === undefined) return
      const db = await open(); const key = keyOf(address)
      const tx = db.transaction(['sessions', 'events'], 'readwrite'); const done = completed(tx)
      const sessions = tx.objectStore('sessions'); const events = tx.objectStore('events')
      const row = metadata(await result<unknown>(sessions.get(key)), key)
      if (row === undefined || row.header.createdAt !== header.createdAt || row.header.version !== header.version
        || records.at(-1)?.event.seq !== row.firstSeq - 1) { await done; return }
      for (const record of records) events.put({ key, seq: record.event.seq, record } satisfies StoredEvent)
      row.firstSeq = first.event.seq
      row.hasMore = hasMore
      sessions.put(row); await done
    }, undefined),
    remove,
    close: async () => {
      closed = true
      await Promise.all(pending)
      if (database !== undefined) await database.then((db) => { db.close() }, (_error: unknown) => {
        // A failed opening has no database connection to release.
      })
    },
  }
}
