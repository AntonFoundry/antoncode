/**
 * Bender's vocabulary for the shared Lisp-dialect grammar
 * (`lisp-dialect-grammar.ts`). Bender is a Janet fork, so its reader syntax is
 * Janet's: `@shikijs/langs` ships neither grammar, and the rule set is shared
 * while the word lists below come from Bender's own TextMate grammar
 * (`grammar/syntaxes/bender.tmLanguage.json` in the language repository), which
 * is generated from the running core library.
 *
 * The fork's twist in source text is the `{:hint …}` declaration contract: the
 * `:hint` keyword names a compiler contract, not a value, so it takes its own
 * keyword scope instead of the ordinary keyword-constant color. The reactor,
 * FFI, and process namespaces (`ev/spawn`, `ffi/defstruct`, `proc/spawn`, …)
 * are control forms here, matching the fork's grammar, and every other
 * `namespace/name` core binding is matched by the shared namespaced pattern.
 */

import { createLispDialectGrammar } from './lisp-dialect-grammar.ts'

/** Bender's special forms and control macros; these read as control keywords. */
const SPECIAL_FORMS = [
  'and', 'or', 'def', 'def-', 'defn', 'defn-', 'defmacro', 'defmacro-', 'defdyn',
  'defmulti', 'defmethod', 'var', 'var-', 'varfn', 'fn', 'fiber-fn', 'short-fn',
  'do', 'if', 'if-let', 'if-not', 'if-with', 'when', 'unless', 'when-let',
  'when-with', 'cond', 'case', 'match', 'let', 'loop', 'repeat', 'forever',
  'while', 'for', 'forv', 'each', 'eachk', 'eachp', 'break', 'try', 'protect',
  'prompt', 'label', 'defer', 'edefer', 'assert', 'assertf', 'comment', 'chr',
  'doc', 'default', 'toggle', 'juxt', 'compif', 'compwhen', 'comptime', 'tracev',
  'quote', 'quasiquote', 'unquote', 'splice', 'upscope', 'set', 'with',
  'with-syms', 'with-dyns', 'with-vars', 'with-env', 'generate', 'coro', 'delay',
  'seq', 'catseq', 'tabseq', 'as-macro', 'as->', 'import', 'use',
  // Reactor, FFI, and process control forms, colored by the fork's own grammar.
  'ev/spawn', 'ev/spawn-thread', 'ev/do-thread', 'ev/gather', 'ev/with-lock',
  'ev/with-rlock', 'ev/with-wlock', 'ev/with-deadline',
  'ffi/defbind', 'ffi/defbind-alias', 'ffi/defstruct',
] as const

/** Non-namespaced core bindings whose call sites read as functions. */
const CORE_FUNCTIONS = [
  // Printing, errors, and I/O.
  'print', 'printf', 'prin', 'prinf', 'pp', 'puts', 'eprint', 'eprintf',
  'error', 'errorf', 'getline', 'slurp', 'spit', 'flush', 'eflush',
  // Collections and sequences.
  'array', 'tuple', 'table', 'struct', 'buffer', 'string', 'symbol', 'keyword',
  'length', 'get', 'put', 'in', 'update', 'get-in', 'put-in', 'update-in',
  'has-key', 'has-value', 'keys', 'values', 'pairs', 'kvs', 'from-pairs', 'merge',
  'merge-into', 'zipcoll', 'slice', 'range', 'map', 'mapcat', 'filter', 'reduce',
  'reduce2', 'apply', 'find', 'find-index', 'index-of', 'some', 'every', 'all',
  'any', 'count', 'first', 'last', 'next', 'take', 'take-while', 'drop',
  'drop-while', 'sort', 'sort-by', 'sorted', 'sorted-by', 'distinct',
  'frequencies', 'group-by', 'partition', 'partition-by', 'interleave',
  'interpose', 'flatten', 'flatten-into', 'reverse', 'reverse!',
  // Clojure-style value helpers.
  'atom', 'deref', 'swap!', 'reset!', 'compare-and-set!', 'lazy-cons', 'lazy-map',
  'lazy-filter', 'lazy-take', 'lazy-take-while', 'lazy-drop', 'lazy-drop-while',
  'lazy-range', 'lazy-to-array', 'realize', 'keep', 'keep-syntax', 'identity',
  'comp', 'complement', 'partial', 'sum', 'mean', 'product', 'min',
  'max', 'min-of', 'max-of', 'inc', 'dec', 'neg', 'not', 'not=', 'deep=',
  'type', 'hash', 'describe', 'json-str',
  // Compilation, environments, and reflection.
  'gensym', 'macex', 'macex1', 'scan-number', 'parse', 'parse-all', 'eval',
  'eval-string', 'compile', 'disasm', 'marshal', 'unmarshal', 'make-env',
  'root-env', 'curenv', 'env-lookup', 'dyn', 'setdyn', 'all-bindings',
  'all-dynamics', 'require', 'signal', 'resume', 'yield', 'cancel', 'fiber',
  'trace', 'untrace', 'debug', 'quit', 'repl',
] as const

/** The registration `loadLanguageSync` accepts for the `bender` id. */
export const benderGrammar = createLispDialectGrammar({
  id: 'bender',
  displayName: 'Bender',
  fileTypes: ['ben'],
  specialForms: SPECIAL_FORMS,
  coreFunctions: CORE_FUNCTIONS,
  keywordLiterals: [{ word: ':hint', scope: 'keyword.other.hint.bender' }],
})

/** The grammar as a shiki language module: the `LanguageRegistration[]` shape `@shikijs/langs` modules export. */
export default [benderGrammar]
