/** Local plugins must remain opt-in and outside application distributions. */
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)

describe('local plugin distribution policy', () => {
  it.each(['macos', 'linux', 'windows'])('excludes root local plugins from the %s harness copy', (platform) => {
    const path = `scripts/build-anton-${platform}.ts`
    const source = ts.createSourceFile(path, readFileSync(new URL(path, root), 'utf8'), ts.ScriptTarget.Latest, true)
    const exclusions: string[][] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'syncDirectory'
        && node.arguments[0]?.getText(source) === 'harnessRoot') {
        const patterns = node.arguments[2]
        if (patterns !== undefined && ts.isArrayLiteralExpression(patterns)) {
          exclusions.push(patterns.elements.filter(ts.isStringLiteral).map(item => item.text))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(exclusions).toHaveLength(1)
    expect(exclusions[0]).toContain('/plugins')
  })

  it('keeps sticky notes out of shipped bundle declarations and workspace discovery', () => {
    for (const bundle of ['base', 'web-app']) {
      const patch = readFileSync(new URL(`packages/bundle/${bundle}/cordis.patch.yml`, root), 'utf8')
      expect(patch).not.toContain('@local/sticky-notes')
    }
    const workspace = readFileSync(new URL('pnpm-workspace.yaml', root), 'utf8')
    expect(workspace).not.toMatch(/^\s*-\s*['"]?plugins\//m)
    const manifest = JSON.parse(readFileSync(new URL('plugins/sticky-notes/package.json', root), 'utf8')) as { private: boolean; files: string[]; exports: Record<string, string> }
    expect(manifest.private).toBe(true)
    expect(manifest.files).toContain('client.js')
    for (const resource of ['.', './client', './icon']) {
      expect(readFileSync(new URL(`plugins/sticky-notes/${manifest.exports[resource]!}`, root)).length).toBeGreaterThan(0)
    }
  })
})
