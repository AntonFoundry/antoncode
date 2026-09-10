/**
 * The standing discipline section: the todo-tree and plugin rules ride every
 * session unconditionally, and the token-efficiency framing rides with them
 * by default — a deployment's `efficiencyDiscipline: false` removes exactly
 * that framing and nothing else.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

async function setup(efficiencyDiscipline?: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, efficiencyDiscipline === undefined ? {} : { efficiencyDiscipline })
  return ctx
}

async function disciplineSection(ctx: Context): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble()
  const section = assembly.sections.find(candidate => candidate.name === 'tools:working-discipline')
  expect(section).toBeDefined()
  return section?.text ?? ''
}

describe('tools:working-discipline section', () => {
  it('carries the todo-tree and plugin rules with efficiency framing by default', async () => {
    const ctx = await setup()
    const text = await disciplineSection(ctx)
    expect(text).toContain('todo tree with todo_write')
    expect(text).toContain('NAME the capability seam')
    expect(text).toContain('tight token budget')
    expect(text).toContain('grep or ripgrep before reading files')
  })

  it('efficiencyDiscipline: false removes only the budget framing', async () => {
    const ctx = await setup(false)
    const text = await disciplineSection(ctx)
    expect(text).toContain('todo tree with todo_write')
    expect(text).toContain('NAME the capability seam')
    expect(text).not.toContain('tight token budget')
  })
})
