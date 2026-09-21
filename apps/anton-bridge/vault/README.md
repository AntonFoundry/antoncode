# Anton vault backup

Encrypted, deduplicated backups of the agent's durable state — session
transcripts, the ambient journal, Blueant settings, the live DSH home —
via [restic](https://restic.net) (AES-256 at rest client-side; the cloud
never sees plaintext).

## Quick start

```sh
brew install restic
sudo cp apps/anton-bridge/vault/anton-vault-backup.sh /usr/local/bin/ && chmod +x /usr/local/bin/anton-vault-backup.sh
anton-vault-backup.sh init        # creates the repo; password lands in the Keychain
anton-vault-backup.sh             # one backup + retention prune
cp apps/anton-bridge/vault/dev.antoncode.anton-vault.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/dev.antoncode.anton-vault.plist   # daily 11:30
```

## Design

- **Repo location**: `~/Library/Mobile Documents/com~apple~CloudDocs/AntonVault`
  (iCloud Drive) by default — the encrypted repo syncs to Apple's servers
  with zero extra credentials. Any restic backend works: set
  `ANTON_VAULT_REPO` (e.g. an S3/B2 URL) before invoking.
- **Password**: generated on first run and stored ONLY in the macOS
  Keychain (service `anton-vault`, account `restic`). Losing both the
  Keychain and every machine that holds it loses the vault — back the
  Keychain up (Time Machine covers it) or record the password in your
  password manager.
- **What is included**: `~/Library/Application Support/Anton/dsh` (sessions,
  journal, profiles, skills, settings). **Excluded**: re-downloadable whisper
  models, session screenshots (bulky, re-derivable), quarantined sessions,
  engine storages.
- **Retention**: `forget --prune --keep-daily 7 --keep-weekly 4
  --keep-monthly 6`, tagged `anton-vault` so other restic uses on the same
  repo are untouched.
- **Schedule**: a LaunchAgent at 11:30 daily; missed runs coalesce into one
  run at next wake.

## Restore

```sh
anton-vault-backup.sh snapshots
RESTORE_TO=/tmp/vault-restore anton-vault-backup.sh restore latest
```

Sessions restore under `.../Application Support/Anton/dsh/...` — quit Anton
before overwriting the live tree, or restore to a scratch dir and copy
selectively.

## Verification

Run a real pass once: `anton-vault-backup.sh backup` then
`RESTORE_TO=/tmp/vault-restore anton-vault-backup.sh restore latest` and
diff a session file. `restic check` inside the repo dir verifies integrity
any time.
