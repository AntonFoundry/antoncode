import { describe, expect, it } from 'vitest'
import { shellCommands } from '../src/shell-commands.ts'

const deploymentPatterns = ['(pnpm\\s+run\\s+)?(deploy|release|publish)\\b', 'npm\\s+publish\\b']
function matches(source: string): boolean {
  const commands = shellCommands(source)
  return commands === undefined
    ? deploymentPatterns.some(pattern => new RegExp(pattern).test(source))
    : commands.some(command => deploymentPatterns.some(pattern => new RegExp(`^(?:${pattern})`).test(command)))
}

describe('literal shell command classification', () => {
  it.each([
    "grep -n 'publish' package.json",
    'cat docs/persistence-release.md',
    "git commit -m 'fix: release gate and terminal dispose'",
    "printf '%s\\n' 'npm publish'",
    "echo 'deploy release publish'",
    '# npm publish\nprintf ok',
    "cat <<'SOURCE' > policy.ts\nconst name = 'publish'\npnpm run release\nSOURCE",
    "tee policy.ts <<'SOURCE'\npublish\nSOURCE\ngit diff",
    'git diff -- docs/persistence-release.md',
    'bash -c "grep publish package.json"',
    'npm "publish next"',
    'export PATH=/opt/homebrew/bin:$PATH; git add scripts/persistence-release.ts && git diff --cached && git commit -m "release docs"',
    'PATH=/opt/homebrew/bin:${PATH} git diff -- scripts/persistence-release.ts',
    'export PATH="/opt/homebrew/bin:$PATH"; cat docs/persistence-release.md',
  ])('does not classify inert deployment text: %s', (command) => {
    expect(shellCommands(command)).toBeDefined()
    expect(matches(command)).toBe(false)
  })

  it.each([
    'npm publish', 'pnpm run release', 'deploy production',
    'cd repo && pnpm run deploy', 'false || npm publish',
    'printf ok; release', 'printf ok\nnpm publish',
    "'npm' 'publish'", '/usr/local/bin/npm publish',
    'env CI=1 npm publish', 'sudo -u runner npm publish',
    'command npm publish', 'exec npm publish',
    'bash -lc \'cd repo && npm publish\'',
    'bash -c \'bash -c "npm publish"\'',
    '(npm publish) | cat',
    "cat <<'EOF'\npublish is data\nEOF\nnpm publish",
    'npm publish > result.log', 'npm publish # --dry-run',
    'export PATH=/opt/homebrew/bin:$PATH; npm publish',
  ])('retains genuine deployment commands: %s', (command) => {
    expect(matches(command)).toBe(true)
  })

  it.each([
    'echo "$(npm publish)"', 'echo `npm publish`',
    'cat <<EOF\n$(npm publish)\nEOF',
    "bash <<'EOF'\nnpm publish\nEOF",
    "python -c 'import os; os.system(\"npm publish\")'",
    "node -e 'require(\"child_process\").execSync(\"npm publish\")'",
    'xargs npm publish', 'ssh host npm publish', 'my-wrapper release', 'git release',
    "cat <<'ONE' <<TWO\ndata\nONE\n$(npm publish)\nTWO",
    'if true; then npm publish; fi',
    'npm publish "unterminated', 'npm $ACTION # publish',
    'export PATH=$(npm publish); git status',
    'export CMD=deploy; $CMD production',
    'PATH=${PATH:-$(npm publish)} git status',
    'export PATH=$PATH; bash -c "$CMD" # release',
    'export PATH=$PATH; npm $ACTION # publish',
  ])('retains raw checks for opaque execution: %s', (command) => {
    expect(shellCommands(command)).toBeUndefined()
    expect(matches(command)).toBe(true)
  })

  it('keeps separate executable and argument words', () => {
    expect(shellCommands('git commit -m "release now" > release.txt; git push origin main'))
      .toEqual(['git commit -m "release now"', 'git push origin main'])
  })
})
