import { describe, expect, it } from 'vitest'
import { setDeclaredPluginEnabled } from '../src/index.ts'

describe('preset plugin enablement edits', () => {
  it('changes one nested child and keeps neighboring rows', () => {
    const rows = [
      { id: 'persona', name: 'persona' },
      { id: 'delegation', name: 'cordis:group', group: true, config: [
        { id: 'child', name: 'child' },
        { id: 'sibling', name: 'sibling', disabled: true },
      ] },
    ]
    setDeclaredPluginEnabled(rows, 'delegation:child', false)
    expect(rows[1]?.config?.[0]).toMatchObject({ id: 'child', disabled: true })
    expect(rows[1]?.config?.[1]).toMatchObject({ id: 'sibling', disabled: true })
    setDeclaredPluginEnabled(rows, 'delegation:child', true)
    expect(rows[1]?.config?.[0]).toMatchObject({ id: 'child', disabled: false })
  })

  it('refuses missing, duplicate, and conditional child ids', () => {
    expect(() => { setDeclaredPluginEnabled([], 'missing', false) }).toThrow('was not found')
    expect(() => { setDeclaredPluginEnabled([
      { id: 'same', name: 'one' }, { id: 'same', name: 'two' },
    ], 'same', false) }).toThrow('ambiguous')
    expect(() => { setDeclaredPluginEnabled([
      { id: 'conditional', name: 'plugin', disabled: { __jsExpr: 'process.platform === "win32"' } },
    ], 'conditional', true) }).toThrow('conditional enablement')
  })

  it('removes an override when re-enabled to its inherited state', () => {
    const inherited = [{ id: 'tool', name: 'tool' }]
    const rows = [{ id: 'tool', name: 'tool', disabled: true }]
    setDeclaredPluginEnabled(rows, 'tool', true, inherited)
    expect(rows).toEqual(inherited)
  })
})
