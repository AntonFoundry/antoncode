/** `worktree` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'mode.aria': '工作区模式，当前：{name}',
  'mode.checkout': '当前检出',
  'mode.new': '新工作树',
  'mode.reuse': '上一个工作树',
  'mode.reuseNamed': '上一个工作树（{branch}）',
  'hint.new': '新工作树基于 origin/main 创建；未跟踪文件（如 .env）不会带入',
  'status.aria': '仓库状态：{branch}，储藏 {count}',
  'status.stash': '储藏 {count}',
  'bar.base': '基于 {base}',
  'bar.base.aria': '新工作树基准分支，当前：{base}',
  'bar.repo.aria': '仓库分支：{branch}',
  'bar.notRepo': '「{folder}」不是 git 仓库——工作树隔离仅适用于 git 仓库',
} satisfies Record<string, string>

/** The worktree namespace key union. */
export type WorktreeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'mode.aria': 'Workspace mode, current: {name}',
  'mode.checkout': 'Current checkout',
  'mode.new': 'New worktree',
  'mode.reuse': 'Previous worktree',
  'mode.reuseNamed': 'Previous worktree ({branch})',
  'hint.new': 'Created from origin/main; untracked files (e.g. .env) stay behind',
  'status.aria': 'Repo status: {branch}, {count} stashes',
  'status.stash': 'Stash {count}',
  'bar.base': 'From {base}',
  'bar.base.aria': 'Base branch for new worktrees, current: {base}',
  'bar.repo.aria': 'Repository branch: {branch}',
  'bar.notRepo': '"{folder}" is not a git repository — worktree isolation applies to git repositories',
} satisfies Record<WorktreeKey, string>
