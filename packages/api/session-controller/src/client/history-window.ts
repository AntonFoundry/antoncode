/** Contiguous browser history retained across physical follow generations. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionAddress, SessionFollowFrame, SessionFollowRequest, SessionHistoryRecord, SessionPage } from '../types.ts'
import { assertHistoryCursor, type CachedSessionHistory, type SessionHistoryCache } from './history-cache.ts'

type Opening = Extract<SessionFollowFrame, { type: 'snapshot' }>

/** Reconciles a disposable cached prefix with Host-confirmed openings and increments. */
export class SessionHistoryWindow {
  private state: CachedSessionHistory | undefined
  private records: SessionHistoryRecord[] = []
  private read = false

  /**
   * @param address - durable Session address.
   * @param cache - optional Client-root browser storage.
   */
  constructor(private readonly address: SessionAddress, private readonly cache?: SessionHistoryCache) {}

  /**
   * Publish a local prefix before the network opening, at most once.
   * @param signal - physical generation cancellation.
   * @param show - cached-history publication callback.
   * @returns an opening read, or undefined when no cache read is needed.
   */
  preview(signal: AbortSignal, show: (history: CachedSessionHistory) => void): Promise<void> | undefined {
    if (this.read || this.cache === undefined) return undefined
    this.read = true
    return this.cache.read(this.address).then((history) => {
      signal.throwIfAborted()
      if (history === undefined) return
      this.state = history
      this.records = [...history.records]
      show({ ...history, records: [...this.records] })
    })
  }

  /**
   * Describe the retained prefix for the next follow opening without changing the window.
   * @returns Resume identity and cursor, or no resume field when no prefix is retained.
   */
  resumeRequest(): Pick<SessionFollowRequest, 'resume'> {
    return this.state === undefined ? {} : { resume: {
      afterSeq: this.state.cursor, createdAt: this.state.header.createdAt, version: this.state.header.version,
    } }
  }

  /**
   * Reconcile and persist a complete opening or an accepted suffix.
   * @param frame - Host-confirmed opening and current identity.
   * @returns the complete window for the generic journal.
   */
  opening(frame: Opening): SessionPage {
    const previous = this.state
    if (frame.resumed === true && (previous === undefined
      || previous.header.id !== frame.header.id || previous.header.createdAt !== frame.header.createdAt
      || previous.header.version !== frame.header.version || frame.cursor < previous.cursor)) {
      throw new RemoteError('gateway/internal', 'Session resume does not match its local history window', {})
    }
    const records = frame.resumed === true ? [...this.records, ...frame.records] : [...frame.records]
    const hasMore = frame.resumed === true ? previous?.hasMore === true : frame.hasMore
    assertHistoryCursor(records, frame.cursor)
    this.records = records
    this.state = { header: frame.header, cursor: frame.cursor, records, hasMore }
    if (frame.resumed === true) void this.cache?.append(this.address, frame.header, frame.records)
    else void this.cache?.replace(this.address, { ...this.state, records: [...records] })
    return { records: [...records], hasMore }
  }

  /**
   * Retain one contiguous durable increment without copying the growing window.
   * @param record - validated live durable event.
   */
  append(record: SessionHistoryRecord): void {
    if (this.state === undefined || record.event.seq !== this.state.cursor + 1) return
    this.records.push(record)
    this.state = { ...this.state, cursor: record.event.seq, records: this.records }
    void this.cache?.append(this.address, this.state.header, [record])
  }

  /**
   * Retain a fetched older page when it adjoins the cached prefix.
   * @param page - validated older or gap-repair page.
   */
  prepend(page: SessionPage): void {
    const tail = page.records.at(-1)?.event.seq
    const first = this.records[0]?.event.seq
    if (this.state === undefined || tail === undefined || first === undefined || tail + 1 !== first) return
    assertHistoryCursor(page.records, tail)
    this.records = [...page.records, ...this.records]
    this.state = { ...this.state, records: this.records, hasMore: page.hasMore }
    void this.cache?.prepend(this.address, this.state.header, page.records, page.hasMore)
  }
}
