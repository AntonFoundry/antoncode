import { describe, expect, it } from 'vitest'
import { appHomeHint } from '../src/opencode-login.ts'

describe('appHomeHint', () => {
  it('stays silent when the app already reads the target home', () => {
    expect(appHomeHint('/app/home', () => true, ['/app/home'])).toBeUndefined()
  })

  it('stays silent when no app home exists on this machine', () => {
    expect(appHomeHint('/other/home', () => false, ['/app/home'])).toBeUndefined()
  })

  it('names the exact re-run when the app reads a different home', () => {
    const hint = appHomeHint('/other/home', path => path === '/app/home', ['/app/home', '/second/home'])
    expect(hint).toContain('--home "/app/home"')
  })

  it('prefers the first existing candidate', () => {
    const hint = appHomeHint('/other/home', () => true, ['/first/home', '/second/home'])
    expect(hint).toContain('--home "/first/home"')
  })
})
