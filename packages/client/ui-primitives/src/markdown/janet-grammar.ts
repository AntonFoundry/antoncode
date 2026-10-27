/**
 * TextMate grammar for Janet, which no `@shikijs/langs` package ships. Janet
 * is a Lisp: the grammar colors the reader-visible structure of a snippet
 * (comments, strings and buffers, numbers, keyword literals, booleans,
 * special forms, and core/namespaced functions) while leaving ordinary
 * symbols to the foreground token. It is loaded synchronously on first use, so
 * a `janet` fence or a `.janet` read card highlights on its first render
 * instead of showing the plain fallback.
 */

import type { LanguageRegistration } from 'shiki/core'

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

/** Escape a literal for a regex alternation. */
function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A symbol boundary: Janet identifiers include punctuation, so `\b` is wrong. */
const SYMBOL_START = '(?<![\\w\\-*+!?=<>/])'
const SYMBOL_END = '(?![\\w\\-*+!?=<>/])'

const SPECIAL_FORM_PATTERN = `${SYMBOL_START}(?:${SPECIAL_FORMS.map(literal).join('|')})${SYMBOL_END}`
const CORE_FUNCTION_PATTERN = `${SYMBOL_START}(?:${CORE_FUNCTIONS.map(literal).join('|')})${SYMBOL_END}`
/** `namespace/name` core names such as `string/format` or `os/time`. */
const NAMESPACED_FUNCTION_PATTERN = `${SYMBOL_START}[a-z][\\w?!-]*/[\\w?!*+<>=.-]+${SYMBOL_END}`

/** The registration `loadLanguageSync` accepts for the `janet` id. */
export const janetGrammar: LanguageRegistration = {
  name: 'janet',
  displayName: 'Janet',
  scopeName: 'source.janet',
  fileTypes: ['janet'],
  patterns: [
    { include: '#comment' },
    { include: '#strings' },
    { include: '#numbers' },
    { include: '#keyword-literals' },
    { include: '#constants' },
    { include: '#special-forms' },
    { include: '#functions' },
    { include: '#operators' },
    { include: '#delimiters' },
    { include: '#quote' },
  ],
  repository: {
    comment: {
      patterns: [
        {
          begin: '#',
          beginCaptures: { 0: { name: 'punctuation.definition.comment.janet' } },
          end: '$',
          name: 'comment.line.number-sign.janet',
        },
      ],
    },
    strings: {
      patterns: [
        {
          begin: '"',
          beginCaptures: { 0: { name: 'punctuation.definition.string.begin.janet' } },
          end: '"',
          endCaptures: { 0: { name: 'punctuation.definition.string.end.janet' } },
          name: 'string.quoted.double.janet',
          patterns: [{ match: '\\\\(?:["\\\\/bfnrt]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[0-9]{1,3})', name: 'constant.character.escape.janet' }],
        },
        {
          begin: '@"',
          beginCaptures: { 0: { name: 'punctuation.definition.string.begin.janet' } },
          end: '"',
          endCaptures: { 0: { name: 'punctuation.definition.string.end.janet' } },
          name: 'string.quoted.double.buffer.janet',
          patterns: [{ match: '\\\\(?:["\\\\/bfnrt]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[0-9]{1,3})', name: 'constant.character.escape.janet' }],
        },
        {
          begin: '@`+',
          beginCaptures: { 0: { name: 'punctuation.definition.string.begin.janet' } },
          end: '`+',
          endCaptures: { 0: { name: 'punctuation.definition.string.end.janet' } },
          name: 'string.quoted.backtick.buffer.janet',
        },
        {
          begin: '`+',
          beginCaptures: { 0: { name: 'punctuation.definition.string.begin.janet' } },
          end: '`+',
          endCaptures: { 0: { name: 'punctuation.definition.string.end.janet' } },
          name: 'string.quoted.backtick.janet',
        },
      ],
    },
    numbers: {
      patterns: [
        {
          match: '(?<![\\w\\-])(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\\d[\\d_]*(?:\\.[\\d_]*)?|\\.\\d[\\d_]*)(?:[eE][+-]?[\\d_]+)?)(?![\\w\\-])',
          name: 'constant.numeric.janet',
        },
      ],
    },
    'keyword-literals': {
      patterns: [
        {
          match: '(?<![\\w\\-]):[^\\s()\\[\\]{}"\',;`~@^]+',
          name: 'constant.language.keyword.janet',
        },
      ],
    },
    constants: {
      patterns: [
        { match: `${SYMBOL_START}(?:nil|true|false)${SYMBOL_END}`, name: 'constant.language.janet' },
      ],
    },
    'special-forms': {
      patterns: [
        { match: SPECIAL_FORM_PATTERN, name: 'keyword.control.janet' },
      ],
    },
    functions: {
      patterns: [
        { match: NAMESPACED_FUNCTION_PATTERN, name: 'support.function.janet' },
        { match: CORE_FUNCTION_PATTERN, name: 'support.function.janet' },
      ],
    },
    operators: {
      patterns: [
        { match: '(?<=\\s|[()\\[\\]{}])(?:[-+*/%<>=!&|^~]+)(?=\\s|[()\\[\\]{}])', name: 'keyword.operator.janet' },
      ],
    },
    delimiters: {
      patterns: [
        { match: '[()\\[\\]{}]', name: 'punctuation.section.janet' },
      ],
    },
    quote: {
      patterns: [
        { match: "'|~|,|;|@|\\^", name: 'punctuation.definition.quote.janet' },
      ],
    },
  },
}

export default [janetGrammar]
