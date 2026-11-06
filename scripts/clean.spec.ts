import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { RepositoryCleaner } from './clean.ts'
import { retainedMigrationSources } from './retained-migration-sources.ts'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const retainedFiles = retainedMigrationSources.flatMap(source => source.files.map(file => `${source.packagePath}/${file}`))

function addRetainedSources(root: string): Map<string, string> {
  return new Map(retainedFiles.map((path) => {
    const content = readFileSync(join(repositoryRoot, path))
    write(join(root, path), content.toString())
    return [path, createHash('sha256').update(content).digest('hex')]
  }))
}

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-clean-'))
  roots.push(root)
  return root
}

function write(path: string, content = ''): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function addProject(root: string, path: string, outDir = 'lib/types'): void {
  write(join(root, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path }] }))
  write(join(root, path, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { composite: true, outDir },
    include: ['src'],
  }))
  write(join(root, path, 'src/index.ts'), 'export {}\n')
}

function link(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RepositoryCleaner', () => {
  it('declares exactly the 24 tracked migration files in the two authorized packages', () => {
    expect(retainedMigrationSources.map(source => source.packagePath)).toEqual([
      'packages/client/runtime', 'packages/host/apiproxy',
    ])
    expect(retainedFiles).toHaveLength(24)
    expect(new Set(retainedFiles).size).toBe(24)
    const tracked = execFileSync('git', ['ls-files', '-z', '--',
      'packages/client/runtime', 'packages/host/apiproxy',
    ], { cwd: repositoryRoot, encoding: 'utf8' }).split('\0').filter(Boolean)
    expect([...retainedFiles].sort()).toEqual(tracked.sort())
    for (const source of retainedMigrationSources) {
      expect(source.rationale.length).toBeGreaterThan(0)
      expect(existsSync(join(repositoryRoot, source.inventory))).toBe(true)
    }
  })

  it('preserves every retained file byte-for-byte and removes only its generated siblings', async () => {
    const root = fixture()
    addProject(root, 'products/shell')
    const hashes = addRetainedSources(root)
    for (const source of retainedMigrationSources) {
      write(join(root, source.packagePath, 'lib/index.js'))
      write(join(root, source.packagePath, 'node_modules/generated'))
      write(join(root, source.packagePath, '.typecheck/state'))
      write(join(root, source.packagePath, 'tsconfig.tsbuildinfo'))
    }
    const cleaner = new RepositoryCleaner(root)
    expect(cleaner.retainedSources).toEqual([])
    const removed = await cleaner.clean()
    expect(cleaner.retainedSources).toEqual(retainedMigrationSources.map(source => `${source.packagePath}/src`))
    expect(removed).toHaveLength(8)
    for (const [path, hash] of hashes) {
      expect(createHash('sha256').update(readFileSync(join(root, path))).digest('hex')).toBe(hash)
    }
    for (const source of retainedMigrationSources) {
      expect(readdirSync(join(root, source.packagePath))).toEqual(['src'])
    }
    expect(await cleaner.clean()).toEqual([])
  })

  it.each([
    'packages/host/apiproxy/src/new.ts',
    'packages/host/apiproxy/src/api/new.ts',
    'packages/host/apiproxy/notes.txt',
    'packages/client/unknown/src/index.ts',
  ])('rejects unexpected content at %s before removing any output', async (path) => {
    const root = fixture()
    addProject(root, 'products/shell')
    addRetainedSources(root)
    write(join(root, 'products/shell/lib/types/index.js'))
    write(join(root, path), 'unexpected')
    const unknownEntry = path.startsWith('packages/client/unknown/') ? 'packages/client/unknown/src' : path
    await expect(new RepositoryCleaner(root).clean()).rejects.toThrow(unknownEntry)
    expect(existsSync(join(root, 'products/shell/lib/types/index.js'))).toBe(true)
    expect(readFileSync(join(root, path), 'utf8')).toBe('unexpected')
  })

  it('rejects an unexpected empty retained-source directory before deleting outputs', async () => {
    const root = fixture()
    addProject(root, 'products/shell')
    addRetainedSources(root)
    write(join(root, 'products/shell/lib/types/index.js'))
    mkdirSync(join(root, 'packages/host/apiproxy/src/unlisted'))
    await expect(new RepositoryCleaner(root).clean()).rejects.toThrow('src/unlisted')
    expect(existsSync(join(root, 'products/shell/lib/types/index.js'))).toBe(true)
  })

  it.each([
    'packages/host/apiproxy/src',
    'packages/host/apiproxy/src/api',
    'packages/host/apiproxy/src/api/flow.ts',
  ])('rejects a retained-source symlink at %s without touching its external target', async (path) => {
    const root = fixture()
    const external = fixture()
    addProject(root, 'products/shell')
    write(join(root, 'products/shell/lib/types/index.js'))
    write(join(external, 'private.ts'), 'external')
    link(external, join(root, path))
    await expect(new RepositoryCleaner(root).clean()).rejects.toThrow(path)
    expect(readFileSync(join(external, 'private.ts'), 'utf8')).toBe('external')
    expect(existsSync(join(root, 'products/shell/lib/types/index.js'))).toBe(true)
  })

  it('rejects build output overlapping retained migration sources', async () => {
    const root = fixture()
    addProject(root, 'packages/host/apiproxy', 'src/types')
    write(join(root, 'packages/host/apiproxy/package.json'), '{}')
    addRetainedSources(root)
    write(join(root, 'packages/host/apiproxy/src/types/generated.js'))
    await expect(new RepositoryCleaner(root).clean()).rejects.toThrow('overlapping retained migration source: packages/host/apiproxy/src')
    expect(existsSync(join(root, 'packages/client/runtime/src/client/sessions/tail.ts'))).toBe(true)
  })

  it('derives live build outputs from project references and removes safe stale package residue', async () => {
    const root = fixture()
    addProject(root, 'products/shell')
    write(join(root, 'products/shell/lib/types/index.js'))
    write(join(root, 'products/shell/lib/index.js'))
    write(join(root, '.typecheck/legacy.tsbuildinfo'))
    write(join(root, '.dsh-build/client-build-environment.json'))
    write(join(root, 'apps/desktop/renderer/assets/welcome-brand.svg'))
    write(join(root, 'apps/desktop/renderer/assets/welcome-loading.svg'))
    write(join(root, 'apps/desktop/renderer/welcome.css'))
    write(join(root, 'root.tsbuildinfo'))
    write(join(root, 'packages/removed/ghost/node_modules/.bin/tool'))

    await new RepositoryCleaner(root).clean()

    expect(existsSync(join(root, 'products/shell/lib'))).toBe(false)
    expect(existsSync(join(root, 'products/shell/src/index.ts'))).toBe(true)
    expect(existsSync(join(root, '.typecheck'))).toBe(false)
    expect(existsSync(join(root, '.dsh-build'))).toBe(false)
    expect(existsSync(join(root, 'apps/desktop/renderer/assets/welcome-brand.svg'))).toBe(true)
    expect(existsSync(join(root, 'apps/desktop/renderer/assets/welcome-loading.svg'))).toBe(true)
    expect(existsSync(join(root, 'apps/desktop/renderer/welcome.css'))).toBe(true)
    expect(existsSync(join(root, 'root.tsbuildinfo'))).toBe(false)
    expect(existsSync(join(root, 'packages/removed/ghost'))).toBe(false)
  })

  it('does not delete any target when a manifest-less package contains an unknown file', async () => {
    const root = fixture()
    addProject(root, 'products/shell')
    write(join(root, 'products/shell/lib/types/index.js'))
    write(join(root, 'packages/removed/ghost/notes.txt'))

    await expect(new RepositoryCleaner(root).clean()).rejects.toThrow('packages/removed/ghost/notes.txt')
    expect(existsSync(join(root, 'products/shell/lib'))).toBe(true)
  })

  it('removes the native Landlock entry output and solution build info', async () => {
    const root = fixture()
    const entry = 'native/system/packages/entry'
    addProject(root, entry, 'lib')
    write(join(root, entry, 'lib/index.js'))
    write(join(root, 'native/system/tsconfig.tsbuildinfo'))

    await new RepositoryCleaner(root).clean()

    expect(existsSync(join(root, entry, 'lib'))).toBe(false)
    expect(existsSync(join(root, entry, 'src/index.ts'))).toBe(true)
    expect(existsSync(join(root, 'native/system/tsconfig.tsbuildinfo'))).toBe(false)
  })

  it('removes pnpm links to deleted or cleaned packages and keeps live links', async () => {
    const root = fixture()
    addProject(root, 'packages/core/live')
    write(join(root, 'packages/core/live/package.json'), '{}')
    write(join(root, 'packages/hooks/stale/lib/index.js'))
    const hoisted = join(root, 'node_modules/.pnpm/node_modules')
    link(join(root, 'packages/core/live'), join(hoisted, '@deepseek-ai/dsh-live'))
    link(join(root, 'packages/hooks/gone'), join(hoisted, '@deepseek-ai/dsh-gone'))
    link(join(root, 'packages/hooks/stale'), join(hoisted, '@deepseek-ai/dsh-stale'))
    link(join(root, 'packages/hooks/plain'), join(hoisted, 'plain'))
    link(join(hoisted, 'loop'), join(hoisted, 'loop'))
    link(join(root, 'packages/hooks/top'), join(root, 'node_modules/@deepseek-ai/dsh-top'))

    await new RepositoryCleaner(root).clean()

    expect(readdirSync(join(hoisted, '@deepseek-ai'))).toEqual(['dsh-live'])
    expect(readdirSync(hoisted)).toEqual(['@deepseek-ai'])
    expect(readdirSync(join(root, 'node_modules/@deepseek-ai'))).toEqual([])
    expect(existsSync(join(hoisted, '@deepseek-ai/dsh-live/package.json'))).toBe(true)
  })

  it('does not scan node_modules outside the repository', async () => {
    const root = fixture()
    const externalModules = fixture()
    addProject(root, 'products/shell')
    link(join(root, 'packages/hooks/gone'), join(externalModules, 'gone'))
    link(externalModules, join(root, 'node_modules'))

    await new RepositoryCleaner(root).clean()

    expect(readdirSync(externalModules)).toEqual(['gone'])
  })

  it('refuses project outputs reached through a symlink outside the repository', async () => {
    const root = fixture()
    const externalProject = fixture()
    write(join(root, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './linked' }] }))
    write(join(externalProject, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { composite: true, outDir: 'lib/types' },
      include: ['src'],
    }))
    write(join(externalProject, 'src/index.ts'), 'export {}\n')
    write(join(externalProject, 'lib/types/index.js'))
    symlinkSync(externalProject, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(new RepositoryCleaner(root).clean()).rejects.toThrow('outside repository')

    expect(existsSync(join(externalProject, 'lib/types/index.js'))).toBe(true)
  })
})
