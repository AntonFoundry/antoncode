import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Phase 5b — cheap-model triage: walk untriaged journal entries (byte
 * watermark per day file), classify worth-keeping vs noise on the cheap
 * model route, and write surviving facts into c0ntext as durable evidence
 * via the same engine endpoint the remember tool uses. Fail-soft like the
 * collector: a failed cycle logs one warning and retries later from the
 * unchanged watermark — entries are never lost and never double-written.
 */

export interface TriageOptions {
  intervalMs?: number
  journalDir?: string
  contextEndpoint?: string
  contextApiKey?: string
  /** Cheap-model id; falls back to the deployment default on rejection. */
  model?: string
}

interface JournalEntry {
  /** Provenance stamp written into the fact: "2026-09-21 09:40:55". */
  stamp: string
  text: string
}

interface TriageVerdict {
  index: number
  keep: boolean
  fact?: string
}

const TRIAGE_SYSTEM_PROMPT = `You triage a personal desktop journal. Each entry records what app was focused, the window title, browser URL, clipboard contents, or a screenshot reference at one moment.
Decide which entries carry durable, useful information about the user's work and interests (a project they are building, a decision, a document, a person, a repeated interest) versus transient noise (idle context, an app merely being open, incidental clipboard noise).
Keep at most the entries that would still matter in a month. For each kept entry write ONE self-contained fact sentence in third person, present tense, naming the concrete subject (project, site, document) — never "the user looked at something".
Respond with ONLY a JSON array, one object per input entry, in order: [{"index": <entry number>, "keep": true|false, "fact": "<sentence, only when keep>"}, ...]`

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/
const ENTRY_HEADING = /^## (\d{2}:\d{2}:\d{2})$/m
const FACT_PREFIX = /- (?:app|window|url|clipboard|screenshot): /

export function startJournalTriage(options: TriageOptions = {}): void {
  const intervalMs = options.intervalMs ?? 5 * 60_000
  let running = false

  const run = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await triageOnce(options)
    } catch (error) {
      console.warn('[triage] cycle failed:', error)
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
  let seen = 0
  let kept = 0
  for (const file of dayFiles(dir)) {
    const watermark = readWatermark(dir, file)
    const full = readFileSync(join(dir, file), 'utf8')
    if (full.length <= watermark.offset) continue
    const fresh = full.slice(watermark.offset)
    const entries = parseEntries(file, fresh, watermark.partialTail)
    if (entries.length === 0) {
      // Nothing parseable yet — advance only past complete entries.
      const safeOffset = watermark.offset + completePrefixLength(fresh)
      writeWatermark(dir, file, safeOffset)
      continue
    }
    seen += entries.length
    for (const batch of chunk(entries, 10)) {
      const verdicts = await classify(batch, options.model)
      for (const verdict of verdicts) {
        const entry = batch[verdict.index]
        if (entry === undefined || !verdict.keep || verdict.fact === undefined || verdict.fact === '') continue
        await writeEvidence(endpoint, apiKey, `${entry.stamp} — ${verdict.fact}`)
        kept += 1
      }
    }
    // Watermark advances to end-of-file only after the whole file's
    // entries classified and wrote; parseEntries consumed the tail.
    writeWatermark(dir, file, full.length)
  }
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
 * Split fresh journal text into `## HH:MM:SS` entries. A trailing block
 * without a heading is the collector's in-progress write and stays
 * unconsumed: parseEntries only returns entries with a full heading, and
 * completePrefixLength lets the watermark advance past the finished ones
 * so a half-written tail is re-read on the next cycle.
 */
function parseEntries(day: string, fresh: string, _partialTail: boolean): JournalEntry[] {
  const entries: JournalEntry[] = []
  const blocks = fresh.split(/(?=^## \d{2}:\d{2}:\d{2}$)/m)
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    const match = ENTRY_HEADING.exec(block)
    if (match === null) continue
    // The last block is the collector's potential write head: skip it so a
    // partially-appended entry is never triaged or never skipped forever.
    if (i === blocks.length - 1 && !endsWithDoubleNewline(block)) continue
    const body = block.slice(block.indexOf('\n') + 1).split('\n').filter(line => FACT_PREFIX.test(line)).join(' · ')
    entries.push({ stamp: `${day} ${match[1]}`, text: body })
  }
  return entries
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

/** One cheap-model call per batch; key/model follow the deployment's moonshotai route. */
async function classify(entries: JournalEntry[], modelOverride?: string): Promise<TriageVerdict[]> {
  // Same env var the harness provider config names (apiKeyEnv in ~/.dsh/settings.yaml).
  const apiKey = process.env.MOONSHOTAI_API_KEY ?? process.env.MOONSHOT_API_KEY ?? ''
  if (apiKey === '') {
    console.warn('[triage] MOONSHOTAI_API_KEY is not set — skipping triage cycle')
    return []
  }
  const listing = entries.map((entry, index) => `${index}. [${entry.stamp}] ${entry.text}`).join('\n')
  // Highspeed is the latency/price tier of the deployed k2.7 route; override
  // with ANTON_TRIAGE_MODEL without touching code.
  const model = modelOverride ?? process.env.ANTON_TRIAGE_MODEL ?? 'kimi-k2.7-code-highspeed'
  return await callTriageModel(apiKey, model, listing, entries.length)
}

async function callTriageModel(apiKey: string, model: string, listing: string, count: number): Promise<TriageVerdict[]> {
  const response = await fetch('https://api.moonshot.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: TRIAGE_SYSTEM_PROMPT },
        { role: 'user', content: `Journal entries:\n${listing}\n\nClassify all ${count} entries.` },
      ],
      temperature: 0,
      max_tokens: 1200,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`triage model HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
  const content = typeof payload.choices?.[0]?.message?.content === 'string' ? payload.choices[0].message.content : ''
  const parsed = JSON.parse(content) as TriageVerdict[]
  if (!Array.isArray(parsed)) throw new Error('triage model returned non-array JSON')
  return parsed.filter(v => typeof v?.index === 'number' && typeof v?.keep === 'boolean')
}

/** Same engine write the remember tool uses; facts land as pinned pages. */
async function writeEvidence(endpoint: string, apiKey: string, text: string): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey !== '') headers.authorization = `Bearer ${apiKey}`
  const response = await fetch(`${endpoint}/pages/archive`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      project_id: 'blueant',
      session_id: 'journal-triage',
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
