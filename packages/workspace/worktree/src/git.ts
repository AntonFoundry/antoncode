/**
 * The git subprocess layer of the worktree registry: every git invocation the
 * registry performs, in one module with parsed outputs and typed failures.
 * Plain `execFile` under an explicit `cwd`; no git library dependency.
 * @module @deepseek-ai/dsh-worktree/src/git
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'

const exec = promisify(execFile)

/** Raised when the queried directory is not inside a git repository. */
export class GitNotARepositoryError extends Error {
  /**
   * @param path - The directory that is not a repository.
   */
  constructor(readonly path: string) {
    super(`'${path}' is not inside a git repository`)
    this.name = 'GitNotARepositoryError'
  }
}

/** Raised when a git invocation exits non-zero; `stderr` carries git's own words. */
export class GitCommandError extends Error {
  /**
   * @param repoPath - Directory the command ran under.
   * @param args - The git arguments, without the `git` literal.
   * @param stderr - Combined git diagnostic output.
   */
  constructor(
    readonly repoPath: string,
    args: readonly string[],
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed under '${repoPath}': ${stderr.trim()}`)
    this.name = 'GitCommandError'
  }
}

/**
 * Run one git command in a directory and return its trimmed stdout.
 * @param repoPath - Working directory for the invocation.
 * @param args - Git arguments, without the `git` literal.
 * @returns the command's trimmed standard output.
 */
export async function runGit(repoPath: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', [...args], { cwd: repoPath, maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim()
  } catch (error: unknown) {
    const reason = error as { code?: number; stderr?: string; message?: string }
    // Exit code 128 with "not a git repository" is the typed
    // not-a-repository case whatever the subcommand (rev-parse probes, and
    // `status` polled against a plain directory); every other failure keeps
    // git's words.
    if (reason.code === 128 && (reason.stderr ?? '').includes('not a git repository')) {
      throw new GitNotARepositoryError(repoPath)
    }
    throw new GitCommandError(repoPath, args, reason.stderr ?? reason.message ?? String(error))
  }
}

/**
 * Resolve the repository root that owns a directory (a workspace may sit in a
 * subdirectory of the repository).
 * @param path - Directory inside the repository.
 * @returns the repository toplevel directory, canonical per git.
 */
export async function gitToplevel(path: string): Promise<string> {
  return await runGit(path, ['rev-parse', '--show-toplevel'])
}

/**
 * Resolve the ONE repository identity shared by a checkout and all its linked
 * worktrees: the parent of the common git dir (`.git` for a plain checkout,
 * the main `.git` for any linked worktree). Preference and record keys use
 * this, so a worktree directory resolves to the same repository key as the
 * main checkout.
 * @param path - Directory inside the repository or any of its worktrees.
 * @returns the main repository root directory.
 */
export async function gitCommonRoot(path: string): Promise<string> {
  const commonDir = await runGit(path, ['rev-parse', '--git-common-dir'])
  return dirname(isAbsolute(commonDir) ? commonDir : resolvePath(path, commonDir))
}

/**
 * Whether a ref exists locally (offline check — a never-fetched `origin/main`
 * reports false rather than reaching the network).
 * @param repoPath - Repository to probe.
 * @param ref - Ref expression such as `refs/heads/agent/x` or `origin/main`.
 * @returns whether the ref resolves locally.
 */
export async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const resolved = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', ref])
    .catch(() => '')
  return resolved !== ''
}

/**
 * Resolve the base ref for a new worktree branch: an explicit request wins,
 * then a locally resolvable `origin/main`, then the current HEAD.
 * @param repoPath - Repository to resolve against.
 * @param explicit - Caller-named base ref; verified when given.
 * @returns the base ref expression actually used.
 */
export async function resolveBase(repoPath: string, explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    if (!await refExists(repoPath, explicit)) {
      throw new GitCommandError(repoPath, ['rev-parse', '--verify', explicit], `unknown base ref '${explicit}'`)
    }
    return explicit
  }
  if (await refExists(repoPath, 'refs/remotes/origin/main')) return 'origin/main'
  return 'HEAD'
}

/**
 * Materialize a worktree: a new branch off `base`, or a fresh checkout of an
 * existing branch when the branch already exists (stale-branch reattachment).
 * Stale admin entries are pruned first: an externally deleted worktree
 * directory leaves its branch registered as checked out, which would
 * otherwise block exactly that reattachment.
 * @param repoPath - Repository to add the worktree to.
 * @param worktreePath - Absolute directory for the new worktree (must not exist).
 * @param branch - Branch to check out; created off `base` when missing.
 * @param base - Base ref for a created branch (unused when the branch exists).
 */
export async function worktreeAdd(repoPath: string, worktreePath: string, branch: string, base: string): Promise<void> {
  await runGit(repoPath, ['worktree', 'prune'])
  if (await refExists(repoPath, `refs/heads/${branch}`)) {
    await runGit(repoPath, ['worktree', 'add', worktreePath, branch])
    return
  }
  await runGit(repoPath, ['worktree', 'add', '-b', branch, worktreePath, base])
}

/**
 * Detach and delete one worktree directory.
 * @param repoPath - Repository owning the worktree.
 * @param worktreePath - Worktree directory to remove.
 * @param force - Remove even when the worktree is dirty or locked.
 */
export async function worktreeRemove(repoPath: string, worktreePath: string, force: boolean): Promise<void> {
  await runGit(repoPath, force ? ['worktree', 'remove', '--force', worktreePath] : ['worktree', 'remove', worktreePath])
}

/** Branch name or short head for the detached state, from `status --porcelain --branch`. */
function branchFromStatusHeader(headerLine: string): string {
  // `## agent/x...origin/agent/x` or `## HEAD (no branch)`.
  const body = headerLine.replace(/^##\s+/, '')
  const name = body.split('...')[0] ?? body
  return name === 'HEAD' || name.startsWith('HEAD ') ? '(detached)' : name
}

/**
 * The live git projection of one working directory: branch, head, dirty flag,
 * stash count, and upstream divergence. Stash count is repository-global
 * (stashes live in the common dir, shared by every worktree of the repo).
 * @param path - Working directory to query (repository root or subdirectory).
 * @returns the status bundle.
 */
/**
 * Candidate base refs for a new worktree branch: every remote-tracking branch
 * in short form (`origin/main`), then `HEAD`, capped so a huge monorepo cannot
 * flood the picker. Remote HEAD symrefs are dropped, `origin/main` and
 * `origin/master` sort first, and the rest sorts alphabetically.
 * @param repoPath - Repository (or worktree) root; refs resolve from the common root.
 * @returns the capped candidate list, `HEAD` always present.
 */
export async function listBases(repoPath: string): Promise<string[]> {
  const output = await runGit(repoPath, ['for-each-ref', '--format=%(refname)', 'refs/remotes'])
    .catch(() => '')
  const remotes = output === '' ? [] : output.split('\n')
    .map(line => line.trim().replace(/^refs\/remotes\//, ''))
    .filter(line => line !== '' && line.split('/').pop() !== 'HEAD')
    .sort((a, b) => {
      // The conventional defaults first, then alphabetical among the rest.
      const rank = (ref: string): number => ref === 'origin/main' ? 0 : ref === 'origin/master' ? 1 : 2
      return rank(a) - rank(b) || a.localeCompare(b)
    })
  return [...remotes.slice(0, 11), 'HEAD']
}

export async function worktreeStatus(path: string): Promise<{
  branch: string
  head: string
  dirty: boolean
  stashCount: number
  ahead: number
  behind: number
}> {
  const statusOutput = await runGit(path, ['status', '--porcelain', '--branch'])
  const lines = statusOutput.split('\n')
  const branch = lines.length > 0 ? branchFromStatusHeader(lines[0] as string) : '(unknown)'
  const dirty = lines.some((line, index) => index > 0 && line.trim() !== '')
  const head = await runGit(path, ['rev-parse', '--short', 'HEAD'])
  /* v8 ignore next -- `git stash list` does not fail on a valid repository; the catch only guards exotic git states. */
  const stashOutput = await runGit(path, ['stash', 'list']).catch(() => '')
  const stashCount = stashOutput === '' ? 0 : stashOutput.split('\n').length
  const upstream = await runGit(path, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
    .catch(() => '0\t0')
  const [behindRaw, aheadRaw] = upstream.split('\t')
  return {
    branch,
    head,
    dirty,
    stashCount,
    ahead: Number.parseInt(aheadRaw ?? '0', 10) || 0,
    behind: Number.parseInt(behindRaw ?? '0', 10) || 0,
  }
}

/**
 * Reduce a free-form name to a path/branch-safe slug: lowercase, ASCII word
 * characters and dashes, capped length, never empty.
 * @param name - Caller-supplied name.
 * @returns the sanitized slug.
 */
export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    .replace(/-+$/g, '')
  return slug === '' ? 'wt' : slug
}
