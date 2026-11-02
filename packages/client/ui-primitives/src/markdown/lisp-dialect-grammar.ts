/**
 * TextMate grammar builder shared by the Lisp dialects the client defines
 * itself because no `@shikijs/langs` package ships a grammar for them. Janet
 * and Bender (a Janet fork with the same reader syntax) differ only in their
 * vocabulary and identity, so the comment, string, number, keyword, constant,
 * operator, delimiter, and quote rules live here once. A dialect's grammar
 * registers synchronously on first use, so its first fence or read card
 * highlights instead of showing the plain fallback.
 */

import type { LanguageRegistration } from 'shiki/core'

/** One keyword literal a dialect colors separately from ordinary keyword constants. */
export interface LispKeywordLiteral {
  /** The literal exactly as written, including its leading colon (`:hint`). */
  word: string
  /** The complete TextMate scope to color it with. */
  scope: string
}

/**
 * One dialect's identity and vocabulary, the input to
 * {@link createLispDialectGrammar}. Everything the dialects share lives in the
 * grammar builder; only names, file types, and words differ.
 */
export interface LispDialect {
  /** Grammar id: shiki's language name and the suffix of every scope it emits (`source.<id>`). */
  id: string
  /** The grammar's own display name. */
  displayName: string
  /** File extensions the grammar claims, without the leading dot. */
  fileTypes: readonly string[]
  /** Forms the dialect colors as control keywords. */
  specialForms: readonly string[]
  /** Core bindings the dialect colors as functions at their call sites. */
  coreFunctions: readonly string[]
  /**
   * Keyword literals the dialect colors as keywords rather than keyword
   * constants, such as Bender's `:hint` declaration contract. Absent for a
   * dialect where every `:name` is an ordinary keyword value.
   */
  keywordLiterals?: readonly LispKeywordLiteral[]
}

/** Escape a literal for a regex alternation. */
function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A symbol boundary: Lisp identifiers include punctuation, so `\b` is wrong. */
const SYMBOL_START = '(?<![\\w\\-*+!?=<>/])'
const SYMBOL_END = '(?![\\w\\-*+!?=<>/])'

/**
 * Build one dialect's grammar from its vocabulary.
 * @param dialect - the dialect's id, display name, file types, and word lists.
 * @returns the registration `loadLanguageSync` accepts for the dialect's id.
 */
export function createLispDialectGrammar(dialect: LispDialect): LanguageRegistration {
  const { id } = dialect
  const SPECIAL_FORM_PATTERN = `${SYMBOL_START}(?:${dialect.specialForms.map(literal).join('|')})${SYMBOL_END}`
  const CORE_FUNCTION_PATTERN = `${SYMBOL_START}(?:${dialect.coreFunctions.map(literal).join('|')})${SYMBOL_END}`
  /** `namespace/name` core names such as `string/format` or `ev/spawn`. */
  const NAMESPACED_FUNCTION_PATTERN = `${SYMBOL_START}[a-z][\\w?!-]*/[\\w?!*+<>=.-]+${SYMBOL_END}`
  const keywordLiteralPatterns = (dialect.keywordLiterals ?? []).map(({ word, scope }) => ({
    match: `(?<![\\w\\-])${literal(word)}(?![\\w\\-])`,
    name: scope,
  }))

  return {
    name: id,
    displayName: dialect.displayName,
    scopeName: `source.${id}`,
    fileTypes: [...dialect.fileTypes],
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
            beginCaptures: { 0: { name: `punctuation.definition.comment.${id}` } },
            end: '$',
            name: `comment.line.number-sign.${id}`,
          },
        ],
      },
      strings: {
        patterns: [
          {
            begin: '"',
            beginCaptures: { 0: { name: `punctuation.definition.string.begin.${id}` } },
            end: '"',
            endCaptures: { 0: { name: `punctuation.definition.string.end.${id}` } },
            name: `string.quoted.double.${id}`,
            patterns: [{ match: '\\\\(?:["\\\\/bfnrt]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[0-9]{1,3})', name: `constant.character.escape.${id}` }],
          },
          {
            begin: '@"',
            beginCaptures: { 0: { name: `punctuation.definition.string.begin.${id}` } },
            end: '"',
            endCaptures: { 0: { name: `punctuation.definition.string.end.${id}` } },
            name: `string.quoted.double.buffer.${id}`,
            patterns: [{ match: '\\\\(?:["\\\\/bfnrt]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[0-9]{1,3})', name: `constant.character.escape.${id}` }],
          },
          {
            begin: '@`+',
            beginCaptures: { 0: { name: `punctuation.definition.string.begin.${id}` } },
            end: '`+',
            endCaptures: { 0: { name: `punctuation.definition.string.end.${id}` } },
            name: `string.quoted.backtick.buffer.${id}`,
          },
          {
            begin: '`+',
            beginCaptures: { 0: { name: `punctuation.definition.string.begin.${id}` } },
            end: '`+',
            endCaptures: { 0: { name: `punctuation.definition.string.end.${id}` } },
            name: `string.quoted.backtick.${id}`,
          },
        ],
      },
      numbers: {
        patterns: [
          {
            match: '(?<![\\w\\-])(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\\d[\\d_]*(?:\\.[\\d_]*)?|\\.\\d[\\d_]*)(?:[eE][+-]?[\\d_]+)?)(?![\\w\\-])',
            name: `constant.numeric.${id}`,
          },
        ],
      },
      'keyword-literals': {
        patterns: [
          ...keywordLiteralPatterns,
          {
            match: '(?<![\\w\\-]):[^\\s()\\[\\]{}"\',;`~@^]+',
            name: `constant.language.keyword.${id}`,
          },
        ],
      },
      constants: {
        patterns: [
          { match: `${SYMBOL_START}(?:nil|true|false)${SYMBOL_END}`, name: `constant.language.${id}` },
        ],
      },
      'special-forms': {
        patterns: [
          { match: SPECIAL_FORM_PATTERN, name: `keyword.control.${id}` },
        ],
      },
      functions: {
        patterns: [
          { match: NAMESPACED_FUNCTION_PATTERN, name: `support.function.${id}` },
          { match: CORE_FUNCTION_PATTERN, name: `support.function.${id}` },
        ],
      },
      operators: {
        patterns: [
          { match: '(?<=\\s|[()\\[\\]{}])(?:[-+*/%<>=!&|^~]+)(?=\\s|[()\\[\\]{}])', name: `keyword.operator.${id}` },
        ],
      },
      delimiters: {
        patterns: [
          { match: '[()\\[\\]{}]', name: `punctuation.section.${id}` },
        ],
      },
      quote: {
        patterns: [
          { match: "'|~|,|;|@|\\^", name: `punctuation.definition.quote.${id}` },
        ],
      },
    },
  }
}
