/**
 * Janet's vocabulary for the shared Lisp-dialect grammar
 * (`lisp-dialect-grammar.ts`), which `@shikijs/langs` does not ship. The
 * grammar colors the reader-visible structure of a snippet (comments, strings
 * and buffers, numbers, keyword literals, booleans, special forms, and
 * core/namespaced functions) while leaving ordinary symbols to the foreground
 * token. It is loaded synchronously on first use, so a `janet` fence or a
 * `.janet` read card highlights on its first render instead of showing the
 * plain fallback.
 */

import { createLispDialectGrammar } from './lisp-dialect-grammar.ts'

/** Janet's special forms; these read as control keywords. */
const SPECIAL_FORMS = [
  'def', 'def-', 'defn', 'defn-', 'defmacro', 'defmacro-', 'defglobal', 'defdyn',
  'var', 'varglobal', 'fn', 'do', 'if', 'quote', 'quasiquote', 'unquote', 'splice',
  'upscope', 'set', 'setdyn', 'break', 'while', 'each', 'eachp', 'for', 'forv',
  'loop', 'repeat', 'forever', 'when', 'unless', 'cond', 'case', 'match', 'try',
  'let',
  'error', 'assert', 'comment', 'with', 'with-syms', 'with-dyns', 'with-vars',
  'defer', 'edef', 'native', 'as', 'as?',
] as const

/** Core bindings whose call sites read as functions; namespaced names are matched separately. */
const CORE_FUNCTIONS = [
  'print', 'printf', 'prin', 'pp', 'string', 'buffer', 'array', 'tuple', 'table',
  'struct', 'keys', 'values', 'pairs', 'length', 'get', 'put', 'in', 'update',
  'map', 'filter', 'reduce', 'range', 'slice', 'apply', 'type', 'describe',
  'pcall', 'xpcall', 'fiber', 'resume', 'yield', 'cancel', 'signal', 'current-fiber',
  'marshal', 'unmarshal', 'parse', 'eval', 'load', 'require', 'import', 'use',
  'module', 'export', 'doc', 'compile', 'trace', 'debug', 'dyn', 'setdyn', 'getdyn',
  'make-env', 'root-env', 'curenv', 'all-bindings', 'all-dynamics',
] as const

/** The registration `loadLanguageSync` accepts for the `janet` id. */
export const janetGrammar = createLispDialectGrammar({
  id: 'janet',
  displayName: 'Janet',
  fileTypes: ['janet'],
  specialForms: SPECIAL_FORMS,
  coreFunctions: CORE_FUNCTIONS,
})

/** The grammar as a shiki language module: the `LanguageRegistration[]` shape `@shikijs/langs` modules export. */
export default [janetGrammar]
