// Throwaway diagnostics: minimal reproduction of the dream distiller's llm.stream path.
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Llm from '@deepseek-ai/dsh-llm'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as ModelsDev from '@deepseek-ai/dsh-llm-models-dev'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const home = process.env.REPRO_HOME ?? '/tmp/dreamrepro/home'
process.env.DSH_HOME = home
const ctx = new Context()
await ctx.plugin(FileSettingsProvider)
await ctx.plugin(LocalCredentialProvider)
await ctx.plugin(Llm)
await ctx.plugin(LlmRetry)
await ctx.plugin(PiAi, { reservedProviders: ['openai'] })
await ctx.plugin(ModelsDev)
const llm = ctx.get('llm')
const candidates = JSON.parse(readFileSync('/tmp/un.json', 'utf8')).candidates.slice(0, 5)
const list = candidates.map((c, i) => `${i + 1}. [${String(c.kind)}] ${String(c.summary)}`).join('\n')
const prompt = [
  "You are the c0ntext dream distiller. Each raw cluster below is mined from this workspace's memory (repeated errors, temporal patterns, related findings).",
  'For EACH cluster, return one crisp lesson sentence worth pinning as durable memory (what keeps failing / what pattern holds), keeping concrete identifiers.',
  'Return JSON only: {"lessons":["lesson 1","lesson 2", ...]} with exactly one entry per input cluster, same order.',
  'Clusters:', list,
].join('\n\n')
const maxTokens = Math.max(512, Math.min(4000, Math.ceil(prompt.length / 4) + 256))
console.log('route:', process.env.REPRO_PROVIDER ?? 'zai', '/', process.env.REPRO_MODEL ?? 'glm-5.3', '| maxTokens:', maxTokens)
const assembler = new BlockAssembler()
let terminal
try {
  for await (const chunk of llm.stream({
    provider: process.env.REPRO_PROVIDER ?? 'zai', model: process.env.REPRO_MODEL ?? 'glm-5.3',
    reasoningEffort: process.env.REPRO_OFF ? ReasoningEffortId('off') : undefined, maxTokens,
    messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'c0ntext-context' } })],
  })) {
    if (chunk.type === 'finish') console.log('finish kind:', chunk.reason.kind, chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted' ? `${chunk.reason.failure.code}: ${chunk.reason.failure.message}` : '')
    assembler.push(chunk)
  }
} catch (error) {
  console.log('STREAM THREW:', error?.message ?? error)
}
const text = assembler.blocks().flatMap(b => b.type === 'text' ? [b.text] : []).join('').trim()
console.log('text len:', text.length)
try {
  const decoded = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''))
  console.log('LESSONS:', decoded.lessons?.length)
} catch (e) { console.log('PARSE FAILED:', e.message, '| tail:', JSON.stringify(text.slice(-60))) }
process.exit(0)
