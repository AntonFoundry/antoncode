import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as GatePolicy from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function guard(commandScope?: 'raw' | 'shellCommands', commandPatterns = ['(pnpm\\s+run\\s+)?(deploy|release|publish)\\b', 'npm\\s+publish\\b']) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GatePolicy, { rules: [{ name: 'deploy-gate', ...(commandScope === undefined ? {} : { commandScope }), commandPatterns, checklist: 'Version, changelog, clean build.' }] })
  const pipeline = new ToolExecutionPipeline(ctx)
  return async (command: string) => {
    const prepared = await pipeline.prepare({
      name: 'bash', arguments: { command },
      callId: ToolCallId('shell-scope-fixture'), signal: new AbortController().signal,
    })
    return ctx.tools.checkGuards(prepared.exec)
  }
}

describe('opt-in shell command gate scope', () => {
  it('preserves legacy raw matching by default and when explicit', async () => {
    for (const scope of [undefined, 'raw'] as const) {
      const check = await guard(scope)
      expect(await check("git commit -m 'release docs'")).toContain("Gate 'deploy-gate' blocked this call")
    }
  })

  it('excludes inert source reads and writes while denying executable deployment', async () => {
    const check = await guard('shellCommands')
    for (const command of ['grep publish package.json', 'cat .agents/skills/dsh-doc/templates/persistence-release.md', "git commit -m 'release docs'", "cat <<'EOF' > a.ts\nconst publish = false\nEOF"]) {
      expect(await check(command)).toBeUndefined()
    }
    for (const command of ['npm publish', 'cd repo && pnpm run release', "bash -c 'npm publish'", 'echo "$(npm publish)"', "node -e 'spawn(\"npm publish\")'"]) {
      expect(await check(command)).toContain("Gate 'deploy-gate' blocked this call")
    }
  })

  it('isolates commands from dry-run text and supports independently configured push/install policies', async () => {
    const check = await guard('shellCommands', ['git\\s+push\\b(?!.*--dry-run)', 'pnpm\\s+run\\s+anton:build:macos\\b', 'cp\\s+.* /Applications/Anton\\.app'])
    expect(await check('git push --dry-run')).toBeUndefined()
    expect(await check('git push origin main; echo --dry-run')).toContain('deploy-gate')
    expect(await check('git push --dry-run; git push origin main')).toContain('deploy-gate')
    expect(await check("printf '%s' 'git push origin main'")).toBeUndefined()
    expect(await check('pnpm run anton:build:macos')).toContain('deploy-gate')
    expect(await check('cp staged.app /Applications/Anton.app')).toContain('deploy-gate')
  })
})
