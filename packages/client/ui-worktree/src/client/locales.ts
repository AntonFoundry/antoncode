/** `worktree` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'mode.checkout': '当前检出（下一会话）',
  'mode.new': '新工作树（下一会话）',
  'mode.reuse': '已删除的工作树',
  'mode.reuseNamed': '工作树 {name}（下一会话）',
  'mode.heading': '{repo} 下一会话的默认工作区',
  'status.aria': '仓库状态：{branch}，储藏 {count}',
  'status.worktree.aria': '工作树 {name}，分支 {branch}，储藏 {count}',
  'status.stash': '储藏 {count}',
  'bar.current': '本会话：{name}',
  'bar.base': '基于 {base}',
  'bar.base.aria': '新工作树基准分支，当前：{base}',
  'bar.repo.aria': '仓库分支：{branch}',
  'bar.repo.worktree.aria': '工作树 {name}，分支 {branch}',
  'bar.notRepo': '「{folder}」不是 git 仓库——工作树隔离仅适用于 git 仓库',
} satisfies Record<string, string>

/** The worktree namespace key union. */
export type WorktreeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'mode.checkout': 'Current checkout (next session)',
  'mode.new': 'New worktree (next session)',
  'mode.reuse': 'Removed worktree',
  'mode.reuseNamed': 'Worktree {name} (next session)',
  'mode.heading': 'Default location for the next session in {repo}',
  'status.aria': 'Repo status: {branch}, {count} stashes',
  'status.worktree.aria': 'Worktree {name}, branch {branch}, {count} stashes',
  'status.stash': 'Stash {count}',
  'bar.current': 'This session: {name}',
  'bar.base': 'From {base}',
  'bar.base.aria': 'Base branch for new worktrees, current: {base}',
  'bar.repo.aria': 'Repository branch: {branch}',
  'bar.repo.worktree.aria': 'Worktree {name}, branch {branch}',
  'bar.notRepo': '"{folder}" is not a git repository — worktree isolation applies to git repositories',
} satisfies Record<WorktreeKey, string>
