import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface EnsureBlueantPresetOptions {
  dshHome: string
  profile: string
  harnessRoot: string
}

/**
 * Blueant's user-trust agent preset: a complete Arivu-style persona (no other
 * prompt sections, no runtime snapshot), a trimmed tool roster, and a scoped
 * c0ntext row tuned for a popup ask-loop (fast retrieval, small budget, scout
 * off). All writes are existsSync-guarded so reruns are no-ops and an existing
 * preset is never clobbered.
 */
export function ensureBlueantPreset({ dshHome }: EnsureBlueantPresetOptions): void {
  const presetDir = join(dshHome, '.agent-presets', 'blueant')
  const ymlPath = join(presetDir, 'agent.cordis.yml')
  const metaPath = join(presetDir, 'preset.yml')
  const restrictPath = join(presetDir, 'plugins', 'restrict-tools.js')
  mkdirSync(presetDir, { recursive: true })
  mkdirSync(dirname(restrictPath), { recursive: true })

  if (!existsSync(restrictPath)) {
    writeFileSync(restrictPath, `${[
      '// Blueant tool roster: memory/search tools only. No bash, no file edits,',
      '// no Anton lifecycle. Names outside the roster become invisible to the',
      '// agent for this preset scope; restrictions intersect with deployment.',
      "export const name = 'blueant-restrict-tools'",
      "export const inject = ['tools']",
      '',
      'export function apply(ctx, config) {',
      '  const known = config.allow.filter(name => ctx.tools.get(name) !== undefined)',
      '  if (known.length === 0) return',
      "  ctx.effect(() => ctx.tools.restrict({ allow: known }), 'blueant.restrict')",
      '}',
      '',
    ].join('\n')}`)
  }
  if (!existsSync(ymlPath)) {
    writeFileSync(ymlPath, `${[
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    text: >-',
      "      You are Blueant, the user's personal desktop agent. You are direct,",
      '      context-aware, and terse. You answer from what you actually read and',
      '      say so — cite the memory entry, recipe, or search result you used.',
      '      You are not a coding assistant: you answer questions and handle small',
      "      tasks about the user's day and machine. Default to one short",
      '      paragraph; ask at most one clarifying question only when the ask is',
      '      genuinely ambiguous.',
      '    complete: true',
      '    includeRuntimeContext: false',
      '- id: restrict-tools',
      '  name: ./plugins/restrict-tools.js',
      '  config:',
      '    allow: [c0ntext_search, c0ntext_remember, recipe_search, web_search, read_image]',
      // NOTE: no c0ntext row here. The plugin registers its toolMatcher service
      // at mount, so a preset-scope second mount fails loud ("service
      // toolMatcher has been registered"); retrieval tuning (retrieveMode,
      // tokenBudget) therefore stays a deployment-layer choice. Scout is
      // already disabled by the plugin's default config.
      '',
    ].join('\n')}`)
  }
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, `${[
      'name: Blueant',
      'description: Personal desktop ask-loop agent for the Anton popup — direct, context-aware, terse.',
      '',
    ].join('\n')}`)
  }
}

/**
 * Junction-symlink the persona package into the profile's node_modules so the
 * preset row's `@deepseek-ai/dsh-persona` name resolves from the host
 * composition — the same mechanism the bridge uses for @c0ntext/dsh-c0ntext.
 */
export function ensureBlueantProfileLink({ dshHome, profile, harnessRoot }: EnsureBlueantPresetOptions): void {
  const personaRoot = resolve(harnessRoot, 'packages', 'preset', 'persona')
  if (!existsSync(personaRoot)) {
    throw new Error(`Bundled persona package was not found at ${personaRoot}`)
  }
  const link = join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh-persona')
  mkdirSync(dirname(link), { recursive: true })
  try {
    if (lstatSync(link).isSymbolicLink()) {
      unlinkSync(link)
    } else {
      throw new Error(`Profile path ${link} exists and is not a symlink`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  symlinkSync(personaRoot, link, 'junction')
}
