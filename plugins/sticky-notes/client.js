window.__ModuleLoader__.load({
  id: '@local/sticky-notes',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'stickyNotes'
    const PANEL_ID = 'sticky-notes'
    const STORAGE_KEY = '@local/sticky-notes/wall'

    const DICTIONARIES = {
      en: {
        panel: 'Sticky notes',
        title: 'Sticky notes',
        subtitle: 'Capture an idea before it escapes.',
        placeholder: 'Write an idea…',
        add: 'Add note',
        empty: 'No notes yet. Write one above.',
        emptyHint: 'Notes stay in this browser.',
        delete: 'Delete note',
        storageFull: 'This browser is out of local storage space, so the last change may not have been kept.',
        countOne: '1 note',
        countOther: '{count} notes',
      },
    }

    /**
     * Read the wall from localStorage.
     * @returns the stored notes, or an empty list when nothing valid is stored.
     */
    function readNotes() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === null) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.filter(note => note !== null && typeof note === 'object'
          && typeof note.id === 'string' && typeof note.text === 'string')
      } catch (_unreadable) {
        // A corrupt or unavailable store reads as an empty wall rather than
        // failing the panel; the next write replaces it.
        return []
      }
    }

    /**
     * Persist the wall.
     * @param notes - the complete note list.
     * @returns whether the write succeeded.
     */
    function writeNotes(notes) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notes))
        return true
      } catch (_quotaOrPrivateMode) {
        return false
      }
    }

    /** The sidebar glyph. The sidebar draws the button; this supplies artwork. */
    function StickyIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.75,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
      },
        h('path', { d: 'M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z' }),
        h('path', { d: 'M14 4v5h5' }),
        h('path', { d: 'M8 13h7M8 17h4' }),
      )
    }

    const styles = {
      page: {
        display: 'flex', flexDirection: 'column', height: '100%',
        minHeight: 0, background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      },
      header: {
        display: 'flex', alignItems: 'baseline', gap: 10,
        padding: '18px 24px 12px', flexShrink: 0,
      },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      subtitle: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      count: { marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      composer: {
        display: 'flex', gap: 8, padding: '0 24px 16px', flexShrink: 0,
        alignItems: 'flex-start',
      },
      input: {
        flex: 1, minHeight: 62, resize: 'vertical', padding: '9px 11px',
        fontSize: 13, lineHeight: 1.5, borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit', outline: 'none',
      },
      addButton: {
        padding: '9px 14px', fontSize: 13, fontWeight: 500, borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
      },
      wall: {
        flex: 1, minHeight: 0, overflowY: 'auto',
        padding: '0 24px 28px',
        display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
        alignContent: 'start',
      },
      note: {
        position: 'relative', minHeight: 120, padding: '12px 13px 30px',
        borderRadius: 10, fontSize: 13, lineHeight: 1.5,
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-primary)',
      },
      noteText: { margin: 0 },
      noteFooter: {
        position: 'absolute', left: 13, right: 10, bottom: 7,
        display: 'flex', alignItems: 'center', gap: 8,
      },
      timestamp: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
      deleteButton: {
        marginLeft: 'auto', border: 'none', background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer',
        fontSize: 11, padding: '2px 4px', borderRadius: 5, fontFamily: 'inherit',
      },
      empty: {
        gridColumn: '1 / -1', padding: '32px 0', textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary)', fontSize: 13,
      },
      emptyHint: {
        gridColumn: '1 / -1', textAlign: 'center',
        color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, marginTop: -4,
      },
      warning: {
        margin: '0 24px 12px', padding: '8px 11px', borderRadius: 8, fontSize: 12,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        color: 'var(--dsw-alias-state-warn-label)',
      },
    }

    /**
     * The sticky wall page.
     * @param root0 - layout props supplied by the slot owner.
     * @param root0.t - translate function bound to this plugin's namespace.
     */
    function StickyWall({ t }) {
      const [notes, setNotes] = React.useState(readNotes)
      const [draft, setDraft] = React.useState('')
      const [failed, setFailed] = React.useState(false)

      const commit = React.useCallback(next => {
        setNotes(next)
        setFailed(!writeNotes(next))
      }, [])

      const add = React.useCallback(() => {
        const text = draft.trim()
        if (text.length === 0) return
        commit([
          { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, createdAt: Date.now() },
          ...notes,
        ])
        setDraft('')
      }, [draft, notes, commit])

      const remove = React.useCallback(id => {
        commit(notes.filter(note => note.id !== id))
      }, [notes, commit])

      const onKeyDown = React.useCallback(event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          add()
        }
      }, [add])

      const countLabel = notes.length === 1 ? t('countOne') : t('countOther', { count: notes.length })

      return h('div', { style: styles.page },
        h('div', { style: styles.header },
          h('h1', { style: styles.title }, t('title')),
          h('span', { style: styles.subtitle }, t('subtitle')),
          h('span', { style: styles.count }, countLabel),
        ),
        h('div', { style: styles.composer },
          h('textarea', {
            style: styles.input,
            value: draft,
            placeholder: t('placeholder'),
            'aria-label': t('placeholder'),
            onChange: event => setDraft(event.target.value),
            onKeyDown,
          }),
          h('button', {
            type: 'button', style: styles.addButton,
            onClick: add, disabled: draft.trim().length === 0,
          }, t('add')),
        ),
        failed ? h('div', { style: styles.warning, role: 'status' }, t('storageFull')) : null,
        notes.length === 0
          ? [
            h('div', { style: styles.empty, key: 'empty' }, t('empty')),
            h('div', { style: styles.emptyHint, key: 'hint' }, t('emptyHint')),
          ]
          : h('div', { style: styles.wall },
            notes.map(note => h('div', { style: styles.note, key: note.id },
              h('p', { style: styles.noteText }, note.text),
              h('div', { style: styles.noteFooter },
                h('span', { style: styles.timestamp },
                  new Date(note.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
                h('button', {
                  type: 'button', style: styles.deleteButton,
                  'aria-label': t('delete'), title: t('delete'),
                  onClick: () => remove(note.id),
                }, '×'),
              ),
            )),
          ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'sticky-notes: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS,
          inject: () => ({ t }),
        }, StickyWall))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS,
          label: () => t('panel'),
        }, StickyIcon))
      },
    }
  },
})
