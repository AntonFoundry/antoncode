/** Conservative shell command extraction for opt-in executable-only gate rules. */
import parse from 'shell-quote/parse.js'

/** An opaque parameter reference; source collisions retain raw checks. */
const PARAMETER = '__DSH_GATE_PARAMETER__'

/** Remove only quoted, inert cat/tee heredocs; executable or expanding bodies stay opaque. */
function withoutDataHeredocs(source: string): string | undefined {
  const lines = source.split('\n')
  const result: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    // Multiline quoted shell scripts are parsed together below, not as heredoc headers.
    if (!line.includes('<<')) { result.push(line); continue }
    let tokens: parse.ParseEntry[]
    try { tokens = parse(line, () => { throw new Error('dynamic shell word') }) }
    catch (error) { void error; return undefined }
    const at = tokens.findIndex(token => typeof token === 'object' && 'op' in token && (token.op === '<<' || token.op === '<<-'))
    if (at < 0) { result.push(line); continue }
    const marker = /<<(-?)\s*(['"])([^'"\n]+)\2/.exec(line)
    const program = typeof tokens[0] === 'string' ? tokens[0].split('/').at(-1) : undefined
    if (marker === null || tokens[at + 1] !== marker[3] || (program !== 'cat' && program !== 'tee')) return undefined
    if (tokens.some((token, index) => typeof token === 'object' && 'op' in token && index !== at && !['>', '>>', '<'].includes(token.op))) return undefined
    const delimiter = marker[3] ?? ''
    let end = i + 1
    while (end < lines.length && (marker[1] === '-' ? lines[end]?.replace(/^\t+/, '') : lines[end]) !== delimiter) end++
    if (end === lines.length) return undefined
    result.push(line.replace(marker[0], ''))
    i = end
  }
  return result.join('\n')
}

/** Keep literal quoting for the tokenizer and expose only unquoted newlines as separators. */
function tokenizable(source: string): string | undefined {
  const parts = source.match(/'[^']*'|"(?:[^"\\]|\\[\s\S])*"|\\[\s\S]|[^'"\\]+/g) ?? []
  if (parts.join('') !== source) return undefined
  const result: string[] = []
  for (const part of parts) {
    if (part.startsWith("'")) { result.push(part); continue }
    const literal = part.startsWith('"') || part.startsWith('\\')
      ? part
      : part.replace(/(^|[ \t;|&()])#[^\n]*/g, '$1')
    // Simple parameter references are opaque until their assignment position is checked.
    // Other expansions can execute code or change command structure and retain raw checks.
    const prepared = part.startsWith('\\') ? literal : literal.replace(/\$(?:[A-Za-z_][A-Za-z\d_]*|\{[A-Za-z_][A-Za-z\d_]*\})/g, PARAMETER)
    if (!part.startsWith('\\') && /[$`]|[<>]\(/.test(prepared)) return undefined
    result.push(prepared === '\\\n' ? '' : prepared.startsWith('"') || prepared.startsWith('\\') ? prepared : prepared.replace(/\n/g, ';'))
  }
  return result.join('')
}

/** Resolve supported literal wrappers; unknown wrapper options retain raw matching. */
function unwrap(words: string[]): string[] | undefined {
  while (words.length > 0) {
    while (/^[A-Za-z_][A-Za-z\d_]*=/.test(words[0] ?? '')) words = words.slice(1)
    const program = words[0]?.split('/').at(-1)
    if (program === 'env' || program === 'sudo' || program === 'command' || program === 'exec') {
      words = words.slice(1)
      while (words[0]?.startsWith('-')) {
        const option = words.shift() ?? ''
        if (option === '--') break
        if (['-u', '-g', '-C', '--user', '--group', '--chdir'].includes(option)) { words.shift(); continue }
        if (!['-i', '-E', '-n', '-H', '-p'].includes(option)) return undefined
      }
      continue
    }
    return words
  }
  return words
}

/**
 * Extract literal simple commands, with executables at the start of each string.
 * Quoted operands and redirection targets are never standalone commands. Simple
 * parameter references are opaque and accepted only in shell/export assignments.
 * Shell `-c` strings recurse; unsupported syntax or opaque interpreters return undefined
 * so callers retain the original raw regex checks rather than silently permitting.
 * This is a checklist classifier, not a shell security sandbox.
 * @param source - Shell text without executing it or reading environment values.
 * @param depth - Current nested shell depth; excessive nesting retains raw checks.
 * @returns Normalized commands, or undefined when raw matching is required.
 */
export function shellCommands(source: string, depth = 0): string[] | undefined {
  if (depth > 8 || source.includes(PARAMETER)) return undefined
  const stripped = withoutDataHeredocs(source)
  if (stripped === undefined) return undefined
  const prepared = tokenizable(stripped)
  if (prepared === undefined) return undefined
  let tokens: parse.ParseEntry[]
  try { tokens = parse(prepared, () => { throw new Error('dynamic shell word') }) }
  catch (error) { void error; return undefined }
  let group: string[] = []
  const groups: string[][] = [group]
  let redirect = false
  for (const token of tokens) {
    if (typeof token === 'string') {
      if (redirect) { redirect = false; continue }
      group.push(token)
    } else if ('comment' in token) {
      // shell-quote comments consume the rest of the input, including normalized newlines.
      return undefined
    } else if ('op' in token && [';', '&&', '||', '|', '|&', '&', '(', ')'].includes(token.op)) {
      group = []
      groups.push(group)
    } else if ('op' in token && ['>', '>>', '<', '>&', '&>', '&>>'].includes(token.op)) {
      redirect = true
    } else return undefined
  }
  const commands: string[] = []
  for (const group of groups) {
    const exported = group[0] === 'export'
    const operands = exported ? group.slice(1) : group
    let assignments = true
    for (const word of operands) {
      const assignment = assignments && /^[A-Za-z_][A-Za-z\d_]*=/.test(word)
      if (word.includes(PARAMETER) && !assignment) return undefined
      if (!assignment) assignments = false
    }
    if (exported) {
      if (!assignments) return undefined
      continue
    }
    const words = unwrap(group)
    if (words === undefined) return undefined
    const executable = words[0]
    if (executable === undefined) continue
    const program = executable.split('/').at(-1) ?? executable
    words[0] = program
    if (['if', 'then', 'else', 'elif', 'do', 'while', 'until', 'for', 'case', 'eval', 'source', '.', '{', '}'].includes(program)) return undefined
    if (/^(?:ba|da|z|k)?sh$/.test(program)) {
      const flag = words.findIndex(word => /^-[^-]*c/.test(word))
      const script = words[flag + 1]
      if (flag < 0 || script === undefined) return undefined
      const nested = shellCommands(script, depth + 1)
      if (nested === undefined) return undefined
      commands.push(...nested)
    } else {
      // Unknown programs may interpret operands as code or commands. Only literal
      // readers/writers and explicit policy command roots permit narrowed matching.
      if (!['cat', 'tee', 'grep', 'egrep', 'fgrep', 'rg', 'printf', 'echo', 'ls', 'pwd', 'head', 'tail', 'wc', 'sort', 'uniq', 'diff', 'cmp', 'stat', 'file', 'test', '[', 'true', 'false', 'cd', 'cp', 'mv', 'rm', 'mkdir', 'touch', 'install', 'npm', 'pnpm', 'yarn', 'deploy', 'release', 'publish', 'git'].includes(program)) return undefined
      if (program === 'git' && !['status', 'diff', 'log', 'show', 'grep', 'ls-files', 'rev-parse', 'add', 'commit', 'push'].includes(words[1] ?? '')) return undefined
      // Preserve operand separation: a quoted multiword argument cannot create a subcommand.
      commands.push(words.map(word => /\s/.test(word) ? JSON.stringify(word) : word).join(' '))
    }
  }
  return commands
}
