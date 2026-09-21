import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { journalEnabled } from './blueant-settings.ts'
import { cheapChat, extractJson } from './cheap-model.ts'

/**
 * Phase 5b — cheap-model triage: walk untriaged journal entries (byte
 * watermark per day file), classify worth-keeping vs noise on the cheap
 * model route, and write surviving facts into c0ntext as durable evidence
 * via the same engine endpoint the remember tool uses. Fail-soft like the
 * collector: a failed cycle logs one warning and retries later from the
 * unchanged watermark — entries are never lost and never double-written.
 *
 * Phase 6c — ingestion backpressure and dedupe: the journal can emit the
 * same observation many times over (same project, same site, day after
 * day), and the cheap model phrases near-identical facts slightly
 * differently each time. A kept fact is dropped when its normalized text
 * was already written (exact match) or is near-duplicate of a recent one
 * (token-set similarity), writes are capped per cycle and per day, and a
 * run of failed cycles backs off instead of hammering a degraded engine.
 */

export interface TriageOptions {
  intervalMs?: number
  journalDir?: string
  contextEndpoint?: string
  contextApiKey?: string
  /** Cheap-model id; falls back to the deployment default on rejection. */
  model?: string
  /** Max evidence writes per cycle (backpressure); default 25. */
  maxWritesPerCycle?: number
  /** Max evidence writes per calendar day; default 150. */
  maxWritesPerDay?: number
}

interface JournalEntry {
  /** Provenance stamp written into the fact: "2026-09-21 09:40:55". */
  stamp: string
  text: string
  /** Byte offset of this entry's start within the day file, so a capped
   * cycle can watermark exactly the first unprocessed entry. */
  offset: number
}

interface TriageVerdict {
  index: number
  keep: boolean
  fact?: string
}

/** Persisted dedupe/backpressure state, rewritten atomically per cycle. */
interface SeenState {
  /** UTC-agnostic local day the counter belongs to. */
  day: string
  dayCount: number
  /** Normalized-fact hashes already written, bounded FIFO. */
  hashes: string[]
  /** Recent normalized facts for similarity checks, bounded FIFO. */
  recent: string[]
}

const TRIAGE_SYSTEM_PROMPT = `You triage a personal desktop journal. Each entry records what app was focused, the window title, browser URL, clipboard contents, or a screenshot reference at one moment.
Decide which entries carry durable, useful information about the user's work and interests (a project they are building, a decision, a document, a person, a repeated interest) versus transient noise (idle context, an app merely being open, incidental clipboard noise).
Keep at most the entries that would still matter in a month. For each kept entry write ONE self-contained fact sentence in third person, present tense, naming the concrete subject (project, site, document) — never "the user looked at something".
Respond with ONLY a JSON object, no prose: {"entries": [{"index": <entry number>, "keep": true|false, "fact": "<sentence, only when keep>"}, ...]} with exactly one object per input entry, in order.`

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/
const ENTRY_HEADING = /^## (\d{2}:\d{2}:\d{2})$/m
const FACT_PREFIX = /- (?:app|window|url|clipboard|screenshot): /
const STAMP_PREFIX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} — /

const MAX_WRITES_PER_CYCLE = 25
const MAX_WRITES_PER_DAY = 150
const MAX_HASHES = 2000
const MAX_RECENT = 200
const SIMILARITY_THRESHOLD = 0.8
const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'user', 'working', 'works', 'on', 'at', 'in', 'to', 'of', 'and', 'or', 'for', 'with', 'about', 'into', 'their', 'his', 'her', 'its'])

export function startJournalTriage(options: TriageOptions = {}): void {
  const intervalMs = options.intervalMs ?? 5 * 60_000
  let running = false
  // Backoff: after consecutive failed cycles, skip this many intervals
  // before retrying, doubling up to an hour — a degraded engine is never
  // hammered by the ingestion loop.
  let consecutiveFailures = 0
  let skipIntervals = 0

  const run = async (): Promise<void> => {
    if (running || !journalEnabled() || skipIntervals > 0) {
      if (skipIntervals > 0) skipIntervals -= 1
      return
    }
    running = true
    try {
      await triageOnce(options)
      consecutiveFailures = 0
    } catch (error) {
      consecutiveFailures += 1
      if (consecutiveFailures >= 2) {
        skipIntervals = Math.min(2 ** (consecutiveFailures - 2), Math.floor(3_600_000 / intervalMs))
        console.warn(`[triage] ${consecutiveFailures} consecutive failures; backing off ${skipIntervals} intervals`)
      } else {
        console.warn('[triage] cycle failed:', error)
      }
    } finally {
      running = false
    }
  }

  // First pass shortly after boot, then on the cadence.
  const boot = setTimeout(() => { void run() }, 30_000)
  boot.unref?.()
  const timer = setInterval(() => { void run() }, intervalMs)
  timer.unref?.()
}

export async function triageOnce(options: TriageOptions = {}): Promise<{ kept: number; seen: number }> {
  const dir = options.journalDir ?? journalDir()
  const endpoint = options.contextEndpoint ?? resolveContextEndpoint()
  const apiKey = options.contextApiKey ?? process.env.ANTON_CONTEXT_API_KEY ?? ''
  const cycleCap = options.maxWritesPerCycle ?? MAX_WRITES_PER_CYCLE
  const dayCap = options.maxWritesPerDay ?? MAX_WRITES_PER_DAY
  const state = loadSeenState(dir)
  const today = localDay()
  if (state.day !== today) {
    state.day = today
    state.dayCount = 0
  }
  if (state.dayCount >= dayCap) {
    console.info(`[triage] daily cap reached (${state.dayCount} writes); resting until tomorrow`)
    return { kept: 0, seen: 0 }
  }
  let seen = 0
  let kept = 0
  let writesLeft = Math.min(cycleCap, dayCap - state.dayCount)
  for (const file of dayFiles(dir)) {
    if (writesLeft <= 0) break
    const watermark = readWatermark(dir, file)
    const full = readFileSync(join(dir, file), 'utf8')
    if (full.length <= watermark.offset) continue
    const fresh = full.slice(watermark.offset)
    const entries = parseEntries(file, fresh)
    if (entries.length === 0) {
      // Nothing parseable yet — advance only past complete entries.
      const safeOffset = watermark.offset + completePrefixLength(fresh)
      writeWatermark(dir, file, safeOffset)
      continue
    }
    seen += entries.length
    let processedThrough = entries[0].offset
    for (const batch of chunk(entries, 10)) {
      if (writesLeft <= 0) break
      const verdicts = await classify(batch, options.model)
      for (const verdict of verdicts) {
        const entry = batch[verdict.index]
        if (entry === undefined || !verdict.keep || verdict.fact === undefined || verdict.fact === '') continue
        const fact = `${entry.stamp} — ${verdict.fact}`
        if (isDuplicateFact(state, verdict.fact)) continue
        if (writesLeft <= 0) break
        await writeEvidence(endpoint, apiKey, fact)
        recordFact(state, verdict.fact)
        appendTriageLedger(fact)
        kept += 1
        writesLeft -= 1
      }
      processedThrough = batchEndOffset(batch)
      if (writesLeft <= 0) break
    }
    // The watermark advances past fully processed batches only: a capped
    // cycle leaves the remaining entries for the next one.
    writeWatermark(dir, file, watermark.offset + processedThrough)
  }
  saveSeenState(dir, state)
  if (seen > 0) console.info(`[triage] ${seen} entries seen, ${kept} kept`)
  return { kept, seen }
}

function journalDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'Anton', 'blueant', 'journal')
}

function resolveContextEndpoint(): string {
  const configured = process.env.ANTON_CONTEXT_ENDPOINT
  if (configured !== undefined && configured !== '') return configured.replace(/\/$/, '')
  try {
    const bridgeConfig = JSON.parse(readFileSync(join(homedir(), 'Library', 'Application Support', 'Anton', 'bridge.json'), 'utf8')) as { contextEndpoint?: unknown }
    if (typeof bridgeConfig.contextEndpoint === 'string') return bridgeConfig.contextEndpoint.replace(/\/$/, '')
  } catch {
    // First boot before the endpoint is configured: triage becomes a no-op
    // until the bridge writes the endpoint into bridge.json.
  }
  return 'http://127.0.0.1:8090'
}

function dayFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => DAY_FILE.test(name)).sort()
}

interface Watermark { offset: number; partialTail: boolean }

function readWatermark(dir: string, file: string): Watermark {
  const path = join(dir, `.${file}.triage-offset`)
  if (!existsSync(path)) return { offset: 0, partialTail: false }
  const offset = Number(readFileSync(path, 'utf8').trim())
  return { offset: Number.isFinite(offset) && offset >= 0 ? offset : 0, partialTail: false }
}

function writeWatermark(dir: string, file: string, offset: number): void {
  writeFileSync(join(dir, `.${file}.triage-offset`), String(offset))
}

/**
 * Split fresh journal text into `## HH:MM:SS` entries with their byte
 * offsets in the fresh slice. A trailing block without a heading is the
 * collector's in-progress write and stays unconsumed: parseEntries only
 * returns entries with a full heading, and completePrefixLength lets the
 * watermark advance past the finished ones so a half-written tail is
 * re-read on the next cycle.
 */
function parseEntries(day: string, fresh: string): JournalEntry[] {
  const entries: JournalEntry[] = []
  const blocks = fresh.split(/(?=^## \d{2}:\d{2}:\d{2}$)/m)
  let offset = 0
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    const blockOffset = offset
    offset += block.length
    const match = ENTRY_HEADING.exec(block)
    if (match === null) continue
    // The last block is the collector's potential write head: skip it so a
    // partially-appended entry is never triaged or never skipped forever.
    if (i === blocks.length - 1 && !endsWithDoubleNewline(block)) continue
    const body = block.slice(block.indexOf('\n') + 1).split('\n').filter(line => FACT_PREFIX.test(line)).join(' · ')
    entries.push({ stamp: `${day} ${match[1]}`, text: body, offset: blockOffset })
  }
  return entries
}

function batchEndOffset(batch: JournalEntry[]): number {
  const last = batch[batch.length - 1]
  // Past the last entry's heading into its body: enough that the next
  // cycle does not re-classify it; the heading itself is the boundary.
  return last.offset + last.text.length + 16
}

function endsWithDoubleNewline(block: string): boolean {
  return block.endsWith('\n\n') || block.endsWith('\n\n\n')
}

function completePrefixLength(fresh: string): number {
  const blocks = fresh.split(/(?=^## \d{2}:\d{2}:\d{2}$)/m)
  let length = 0
  for (let i = 0; i < blocks.length; i += 1) {
    if (i === blocks.length - 1 && !endsWithDoubleNewline(blocks[i])) break
    length += blocks[i].length
  }
  return length
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Normalize a fact for dedupe: drop the stamp prefix, casefold, collapse
 * whitespace, drop trailing punctuation. The stamp is provenance, not
 * identity — the same observation on another day is the same fact. */
function normalizeFact(fact: string): string {
  return fact.replace(STAMP_PREFIX, '').toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim()
}

function factTokens(normalized: string): Set<string> {
  return new Set(normalized.split(/[^a-z0-9]+/).filter(token => token.length >= 3 && !STOPWORDS.has(token)))
}

/** Exact-normalized or near-duplicate (Jaccard over informative tokens
 * against the recent facts) — the cheap model phrases repeated
 * observations slightly differently, so token overlap catches what the
 * exact hash misses without an engine round-trip. */
function isDuplicateFact(state: SeenState, fact: string): boolean {
  const normalized = normalizeFact(fact)
  if (normalized === '') return true
  const hash = factHash(normalized)
  if (state.hashes.includes(hash)) return true
  const tokens = factTokens(normalized)
  if (tokens.size === 0) return true
  for (const recent of state.recent) {
    const other = factTokens(recent)
    let shared = 0
    for (const token of tokens) if (other.has(token)) shared += 1
    const union = tokens.size + other.size - shared
    if (union > 0 && shared / union >= SIMILARITY_THRESHOLD) return true
  }
  return false
}

function recordFact(state: SeenState, fact: string): void {
  const normalized = normalizeFact(fact)
  state.hashes.push(factHash(normalized))
  if (state.hashes.length > MAX_HASHES) state.hashes.splice(0, state.hashes.length - MAX_HASHES)
  state.recent.push(normalized)
  if (state.recent.length > MAX_RECENT) state.recent.splice(0, state.recent.length - MAX_RECENT)
  state.dayCount += 1
}

function factHash(normalized: string): string {
  // FNV-1a: short, dependency-free, stable across processes.
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16)
}

function localDay(): string {
  return new Date().toISOString().slice(0, 10)
}

function seenStatePath(dir: string): string {
  return join(dir, '.triage-seen.json')
}

function loadSeenState(dir: string): SeenState {
  try {
    if (existsSync(seenStatePath(dir))) {
      const parsed = JSON.parse(readFileSync(seenStatePath(dir), 'utf8')) as Partial<SeenState>
      return {
        day: typeof parsed.day === 'string' ? parsed.day : localDay(),
        dayCount: Number.isFinite(parsed.dayCount) ? Number(parsed.dayCount) : 0,
        hashes: Array.isArray(parsed.hashes) ? parsed.hashes.filter(h => typeof h === 'string') : [],
        recent: Array.isArray(parsed.recent) ? parsed.recent.filter(r => typeof r === 'string') : [],
      }
    }
  } catch {
    // Corrupt state is treated as empty: worst case a few duplicate
    // writes, never lost entries.
  }
  return { day: localDay(), dayCount: 0, hashes: [], recent: [] }
}

function saveSeenState(dir: string, state: SeenState): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(seenStatePath(dir), JSON.stringify(state))
  } catch {
    // Persistence failure only costs dedupe fidelity, never facts.
  }
}

/** One cheap-model call per batch; the shared route handles tiers/fallbacks. */
async function classify(entries: JournalEntry[], modelOverride?: string): Promise<TriageVerdict[]> {
  const listing = entries.map((entry, index) => `${index}. [${entry.stamp}] ${entry.text}`).join('\n')
  const text = await cheapChat({
    model: modelOverride,
    system: TRIAGE_SYSTEM_PROMPT,
    user: `Journal entries:\n${listing}\n\nClassify all ${entries.length} entries.`,
    maxTokens: 1200,
  })
  const unwrapped = JSON.parse(extractJson(text)) as { entries?: TriageVerdict[] } | TriageVerdict[]
  const parsed = Array.isArray(unwrapped) ? unwrapped : unwrapped.entries ?? []
  return parsed.filter(v => typeof v?.index === 'number' && typeof v?.keep === 'boolean')
}

/** Same engine write the remember tool uses, scoped to the registered
 * `global` project under a dedicated journal session so c0ntext search can
 * recall Blueant's observations without polluting coding projects. */
async function writeEvidence(endpoint: string, apiKey: string, text: string): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey !== '') headers.authorization = `Bearer ${apiKey}`
  const response = await fetch(`${endpoint}/pages/archive`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      project_id: 'global',
      session_id: 'blueant-journal',
      page_key: `journal:${Date.now().toString(36)}`.slice(0, 256),
      start_seq: 0,
      end_seq: 0,
      nodes: 1,
      text: text.slice(0, 16_000),
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`engine rejected triage evidence: HTTP ${response.status}`)
}

/** Triage ledger for observability: one line per kept fact. */
export function appendTriageLedger(text: string): void {
  const dir = join(homedir(), 'Library', 'Application Support', 'Anton', 'blueant', 'journal')
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, '.triage-ledger.md'), `- ${text}\n`, 'utf8')
}
