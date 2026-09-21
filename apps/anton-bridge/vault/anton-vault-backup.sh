#!/usr/bin/env bash
# anton-vault-backup: encrypted, deduplicated backup of Anton's durable state.
#
# What it protects: the agent's memory — durable session transcripts, the
# ambient journal, triaged c0ntext evidence config, Blueant settings, and the
# live DSH home (profiles + skills). Re-downloadable binaries (whisper
# models) and caches are excluded.
#
# Where: a restic repository. Default location is inside iCloud Drive so the
# encrypted repo syncs to Apple's servers with zero extra credentials; any
# restic backend works by overriding ANTON_VAULT_REPO.
#
# Secrets: the restic repository password lives ONLY in the macOS Keychain
# under service "anton-vault" (account "restic"). The script creates it on
# first run and reads it thereafter; it is never written next to the repo.
#
# Schedule: a LaunchAgent runs this daily (see dev.antoncode.anton-vault.plist).
#
# Usage:
#   anton-vault-backup.sh            # run one backup + prune
#   anton-vault-backup.sh init       # create the repo (idempotent) and exit
#   anton-vault-backup.sh snapshots  # list restore points
#   RESTORE_TO=<dir> anton-vault-backup.sh restore <snapshot-id|latest>
set -euo pipefail

BACKUP_ROOTS=(
  "$HOME/Library/Application Support/Anton/dsh"
)
# Never leave these in the vault: multi-GB re-downloadable models and
# volatile caches. Patterns are restic excludes (relative to each root).
EXCLUDES=(
  '*/blueant/models/**'
  '*/sessions.quarantine-*/**'
  '*/storages/**'
  '**/.sessions/**/screenshots/**'
)

DEFAULT_REPO="$HOME/Library/Mobile Documents/com~apple~CloudDocs/AntonVault"
REPO="${ANTON_VAULT_REPO:-$DEFAULT_REPO}"
KEYCHAIN_SERVICE="anton-vault"
KEEP_DAILY=7 KEEP_WEEKLY=4 KEEP_MONTHLY=6

log() { printf '[anton-vault] %s\n' "$*"; }
die() { printf '[anton-vault] ERROR: %s\n' "$*" >&2; exit 1; }

command -v restic >/dev/null 2>&1 || die "restic not found — install with: brew install restic"
for root in "${BACKUP_ROOTS[@]}"; do
  [ -d "$root" ] || die "backup root missing: $root"
done

# The repo password: Keychain-only. First run generates and stores it.
# Head reads a finite 48 bytes (no SIGPIPE producer), base64 encodes, and
# non-alphanumerics are stripped before truncation.
if ! REPO_PASSWORD=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a restic -w 2>/dev/null); then
  REPO_PASSWORD="$(head -c 48 /dev/urandom | base64 | tr -d '/+=')"
  REPO_PASSWORD="${REPO_PASSWORD:0:48}"
  [ -n "$REPO_PASSWORD" ] || die "cannot generate password"
  security add-generic-password -s "$KEYCHAIN_SERVICE" -a restic -w "$REPO_PASSWORD" \
    -l "Anton vault restic password" || die "cannot write to Keychain"
  log "generated a new repository password in the Keychain (service: $KEYCHAIN_SERVICE)"
fi
export RESTIC_REPOSITORY="$REPO"
export RESTIC_PASSWORD="$REPO_PASSWORD"

excludes=()
for pattern in "${EXCLUDES[@]}"; do excludes+=(--exclude "$pattern"); done

case "${1:-backup}" in
init)
  restic snapshots >/dev/null 2>&1 && { log "repository already initialised at $REPO"; exit 0; }
  restic init || die "repository init failed"
  log "repository initialised at $REPO — back up the Keychain before trusting it"
  ;;
snapshots)
  restic snapshots
  ;;
restore)
  SNAPSHOT="${2:-latest}"
  [ -n "${RESTORE_TO:-}" ] || die "set RESTORE_TO=<dir> for restore"
  restic restore "$SNAPSHOT" --target "$RESTORE_TO"
  log "restored $SNAPSHOT into $RESTORE_TO"
  ;;
backup)
  mkdir -p "$REPO"
  restic snapshots >/dev/null 2>&1 || { log "first run: initialising repository"; restic init; }
  log "backing up ${#BACKUP_ROOTS[@]} roots to $REPO"
  restic backup "${BACKUP_ROOTS[@]}" "${excludes[@]}" --tag anton-vault
  restic forget --prune --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" --tag anton-vault
  log "backup complete"
  ;;
*)
  die "unknown command: $1 (backup | init | snapshots | restore)"
  ;;
esac
