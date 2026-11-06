window.__ModuleLoader__.load({
  id: '@local/sticky-notes',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'stickyNotes'
    const PANEL_ID = 'sticky-notes'
    const STORAGE_KEY = '@local/sticky-notes/wall'

    /**
     * Paper colors for the wall, in the order a note picks one. Each entry is a
     * two-stop vertical gradient so a note reads as paper catching light from
     * above rather than a flat fill; `ink` is the text color for that paper.
     */
    const PAPERS = [
      { paper: 'linear-gradient(180deg, #fff7a1 0%, #ffe664 100%)', ink: '#3b3508' },
      { paper: 'linear-gradient(180deg, #ffcfe0 0%, #ffa8c8 100%)', ink: '#4a1f31' },
      { paper: 'linear-gradient(180deg, #ffdcaa 0%, #ffbe78 100%)', ink: '#4a3113' },
      { paper: 'linear-gradient(180deg, #d3f2b8 0%, #a9e18f 100%)', ink: '#233c16' },
      { paper: 'linear-gradient(180deg, #c9e3ff 0%, #9fcbff 100%)', ink: '#14304d' },
      { paper: 'linear-gradient(180deg, #e4d0ff 0%, #c6a8ff 100%)', ink: '#33204f' },
    ]

    const DICTIONARIES = {
      en: {
        panel: 'Sticky notes',
        title: 'Sticky notes',
        subtitle: 'Capture an idea before it escapes.',
        placeholder: 'Write an idea…',
        add: 'Stick it',
        empty: 'The wall is empty. Write your first note above.',
        emptyHint: 'Notes stay in this browser.',
        delete: 'Delete note',
        storageFull: 'Could not save this change. Your draft and notes have been kept. Try again after making browser storage available.',
        storageUnreadable: 'Saved notes could not be read. No changes will be saved, so your stored data stays untouched.',
        countOne: '1 note',
        countOther: '{count} notes',
      },
    }

    /** Read and validate saved notes without replacing unreadable data. */
    function readNotes() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === null) return { notes: [], readable: true }
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed) || !parsed.every(note => note !== null && typeof note === 'object'
          && typeof note.id === 'string' && typeof note.text === 'string'
          && typeof note.createdAt === 'number' && Number.isFinite(note.createdAt)
          && Number.isFinite(new Date(note.createdAt).getTime()))) {
          return { notes: [], readable: false }
        }
        return { notes: parsed, readable: true }
      } catch (_unreadable) {
        return { notes: [], readable: false }
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

    /**
     * Stable small hash of a note id.
     * @param id - the note identity.
     * @returns a non-negative integer.
     */
    function hashOf(id) {
      let hash = 0
      for (let index = 0; index < id.length; index += 1) {
        hash = (hash * 31 + id.charCodeAt(index)) | 0
      }
      return Math.abs(hash)
    }

    /**
     * Derive a note's paper and tilt from its id, so a card keeps its exact
     * handmade placement across reloads without storing either value.
     * @param id - the note identity.
     * @returns the paper entry and a tilt in degrees.
     */
    function placementOf(id) {
      const hash = hashOf(id)
      return {
        paper: PAPERS[hash % PAPERS.length],
        tilt: ((hash % 41) - 20) / 9,
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

    /**
     * Interaction styles an inline style object cannot express: hover lift,
     * the delete control, and the composer's focus ring. Rendered
     * as a style element so unmounting removes it.
     */
    const WALL_CSS = `
.dshStickyNote {
  transition: transform 160ms ease, box-shadow 160ms ease, filter 160ms ease;
}
@media (hover: hover) {
.dshStickyNote:hover {
  transform: rotate(0deg) translateY(-4px) scale(1.025) !important;
  box-shadow: 0 14px 26px rgba(0, 0, 0, 0.18), 0 3px 6px rgba(0, 0, 0, 0.10) !important;
  z-index: 3;
}
}
.dshStickyDelete {
  opacity: 0.55;
  transition: opacity 120ms ease, color 120ms ease;
}
.dshStickyDelete:focus-visible {
  opacity: 1;
}
@media (hover: hover) {
.dshStickyNote:hover .dshStickyDelete { opacity: 1; }
.dshStickyDelete:hover {
  color: #b3261e !important;
}
.dshStickyAdd:hover:not(:disabled) {
  filter: brightness(1.06);
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.18);
}
}
.dshStickyAdd:disabled {
  opacity: 0.45;
  cursor: default;
}
.dshStickyComposer {
  transition: box-shadow 160ms ease;
}
.dshStickyComposer:focus-within {
  box-shadow: 0 10px 20px rgba(0, 0, 0, 0.16), 0 2px 4px rgba(0, 0, 0, 0.10);
}
@media (prefers-reduced-motion: reduce) {
  .dshStickyNote, .dshStickyDelete { transition: none; }
  .dshStickyNote:hover { transform: rotate(0deg) !important; }
}
`

    const styles = {
      page: {
        position: 'relative', display: 'flex', flexDirection: 'column',
        height: '100%', minHeight: 0,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      },
      header: {
        display: 'flex', alignItems: 'baseline', gap: 10,
        padding: '20px 28px 14px', flexShrink: 0, flexWrap: 'wrap',
      },
      title: { fontSize: 15, fontWeight: 600, margin: 0, letterSpacing: '-0.01em' },
      subtitle: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      count: { marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      composerWrap: { padding: '0 28px 22px', flexShrink: 0 },
      composer: {
        position: 'relative', width: 268, maxWidth: '100%',
        minHeight: 132, borderRadius: 3,
        padding: '16px 16px 46px',
        background: PAPERS[0].paper,
        color: PAPERS[0].ink,
        boxShadow: '0 6px 14px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.10)',
        transform: 'rotate(-0.6deg)',
      },
      composerInput: {
        display: 'block', width: '100%', minHeight: 52,
        border: 'none', outline: 'none', resize: 'none',
        background: 'transparent', color: 'inherit',
        fontSize: 14, lineHeight: 1.45, fontFamily: 'inherit',
        padding: 0,
      },
      composerActions: {
        position: 'absolute', right: 12, bottom: 11,
        display: 'flex', alignItems: 'center', gap: 10,
      },
      hint: { fontSize: 11, opacity: 0.55 },
      addButton: {
        padding: '6px 13px', fontSize: 12.5, fontWeight: 600, borderRadius: 6,
        border: '1px solid rgba(0, 0, 0, 0.18)',
        background: 'rgba(255, 255, 255, 0.72)',
        color: '#3b3508', cursor: 'pointer', fontFamily: 'inherit',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.10)',
      },
      wall: {
        flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        padding: '4px 28px 40px',
        display: 'grid', gap: '20px 18px',
        gridTemplateColumns: 'repeat(auto-fill, minmax(178px, 1fr))',
        alignContent: 'start',
      },
      note: {
        position: 'relative', aspectRatio: '1 / 1',
        display: 'flex', flexDirection: 'column',
        borderRadius: 2, padding: '18px 16px 30px',
        fontSize: 14, lineHeight: 1.45,
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        boxShadow: '0 5px 12px rgba(0, 0, 0, 0.13), 0 1px 2px rgba(0, 0, 0, 0.10)',
      },
      noteText: {
        margin: 0, flex: 1, minHeight: 0, overflow: 'hidden',
        overflowY: 'auto',
      },
      noteFooter: {
        position: 'absolute', left: 16, right: 12, bottom: 9,
        display: 'flex', alignItems: 'center', gap: 8,
      },
      timestamp: { fontSize: 10.5, opacity: 0.5, letterSpacing: '0.01em' },
      deleteButton: {
        marginLeft: 'auto', border: 'none', background: 'transparent',
        color: 'inherit', cursor: 'pointer', opacity: 0.55,
        fontSize: 15, lineHeight: 1, padding: '2px 4px', borderRadius: 4,
        fontFamily: 'inherit',
      },
      empty: {
        gridColumn: '1 / -1', padding: '38px 0 6px', textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary)', fontSize: 13,
      },
      emptyHint: {
        gridColumn: '1 / -1', textAlign: 'center',
        color: 'var(--dsw-alias-label-tertiary)', fontSize: 12,
      },
      warning: {
        margin: '0 28px 14px', padding: '8px 11px', borderRadius: 8, fontSize: 12,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        color: 'var(--dsw-alias-state-warn-label)',
      },
    }

    /**
     * One paper note on the wall.
     * @param root0 - the note record and its callbacks.
     * @param root0.note - the stored note.
     * @param root0.onRemove - removes this note.
     * @param root0.deleteLabel - accessible label for the delete control.
     */
    function Note({ note, onRemove, deleteLabel }) {
      const { paper, tilt } = placementOf(note.id)
      const background = paper.paper
      const stamped = new Date(note.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      return h('div', {
        className: 'dshStickyNote',
        style: {
          ...styles.note,
          background,
          color: paper.ink,
          transform: `rotate(${tilt.toFixed(2)}deg)`,
        },
      },
        h('p', { style: styles.noteText }, note.text),
        h('div', { style: styles.noteFooter },
          h('span', { style: styles.timestamp }, stamped),
          h('button', {
            type: 'button', className: 'dshStickyDelete',
            style: styles.deleteButton,
            'aria-label': deleteLabel, title: deleteLabel,
            onClick: () => onRemove(note.id),
          }, '×'),
        ),
      )
    }

    /**
     * The sticky wall page.
     * @param root0 - layout props supplied by the slot owner.
     * @param root0.t - translate function bound to this plugin's namespace.
     */
    function StickyWall({ t }) {
      const [initial] = React.useState(readNotes)
      const [notes, setNotes] = React.useState(initial.notes)
      const [draft, setDraft] = React.useState('')
      const [failed, setFailed] = React.useState(false)

      const commit = React.useCallback(next => {
        if (!initial.readable) return false
        if (!writeNotes(next)) {
          setFailed(true)
          return false
        }
        setNotes(next)
        setFailed(false)
        return true
      }, [initial.readable])

      const add = React.useCallback(() => {
        const text = draft.trim()
        if (text.length === 0) return
        const saved = commit([
          { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, createdAt: Date.now() },
          ...notes,
        ])
        if (saved) setDraft('')
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
        h('style', { key: 'wall-css' }, WALL_CSS),
        h('div', { style: styles.header },
          h('h1', { style: styles.title }, t('title')),
          h('span', { style: styles.subtitle }, t('subtitle')),
          h('span', { style: styles.count }, countLabel),
        ),
        h('div', { style: styles.composerWrap },
          h('div', { className: 'dshStickyComposer', style: styles.composer },
            h('textarea', {
              style: styles.composerInput,
              value: draft,
              placeholder: t('placeholder'),
              'aria-label': t('placeholder'),
              onChange: event => setDraft(event.target.value),
              onKeyDown,
            }),
            h('div', { style: styles.composerActions },
              h('span', { style: styles.hint }, '⌘↵'),
              h('button', {
                type: 'button', className: 'dshStickyAdd', style: styles.addButton,
                onClick: add, disabled: !initial.readable || draft.trim().length === 0,
              }, t('add')),
            ),
          ),
        ),
        !initial.readable
          ? h('div', { style: styles.warning, role: 'status' }, t('storageUnreadable'))
          : failed ? h('div', { style: styles.warning, role: 'status' }, t('storageFull')) : null,
        notes.length === 0
          ? [
            h('div', { style: styles.empty, key: 'empty' }, t('empty')),
            h('div', { style: styles.emptyHint, key: 'hint' }, t('emptyHint')),
          ]
          : h('div', { style: styles.wall },
            notes.map(note => h(Note, {
              key: note.id, note,
              onRemove: remove,
              deleteLabel: t('delete'),
            })),
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
