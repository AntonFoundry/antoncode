# Mobile ingestion — "Send to Blueant"

An iPhone Shortcut writes a note into iCloud Drive; the bridge ingests it
into the ambient journal, where triage and consolidation turn it into
durable memory. No app, no server, no push channel — a shared folder is
the whole transport.

## One-time setup

1. On the iPhone, open **Shortcuts** → new shortcut:
   - **Receive** what: Text (and enable *Show in Share Sheet*).
   - **Save File**: text, into `iCloud Drive/Anton Inbox`, with a name like
     `Note` + *Current Date* (ask-on-run also works).
   - Optional: name it "Send to Blueant" and enable it as a share-sheet
     target and/or on the Lock Screen.
2. The bridge creates `~/Library/Mobile Documents/com~apple~CloudDocs/Anton
   Inbox` on its next poll (within ~15 s of the bridge running). The first
   note lands in today's `journal/YYYY-MM-DD.md` as:

   ```markdown
   ## HH:MM:SS
   - source: mobile-ingest
   <your note text verbatim>
   ```

3. Notes move to `Anton Inbox/.processed/` after ingestion — kept, never
   deleted. Unsupported files (anything without a `.txt`/`.md` extension)
   are ignored in place.

## Behavior notes

- Poll interval: 15 s (`ANTON_INBOX_INTERVAL_MS` overrides). iCloud
  materializes files asynchronously; offline notes wait in the folder and
  ingest whenever the Mac next sees them.
- Notes longer than 4000 chars truncate; lines starting `## ` are quoted
  (`> ## `) so the journal's entry headers stay unambiguous.
- Toggle: `mobileIngestEnabled` in the Blueant settings file (default on —
  the folder only ever contains what you explicitly save there).
- Voice memos and photos are a future surface (transcription/attachment
  ingestion); text today.
