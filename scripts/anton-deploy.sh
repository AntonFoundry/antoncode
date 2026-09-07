#!/bin/bash
# anton-deploy.sh — in-place bundle installer.
#
# Swaps dist/Anton.next.app into dist/Anton.app WITHOUT quitting the running
# app. The running processes keep their open file handles; the NEXT runtime
# start (menu-bar "Restart Harness", the anton_restart tool, or a fresh app
# launch) picks up the new bundle. This replaces the old quit-swap-relaunch
# flow, whose `open` relaunch never came up reliably — the app shut down and
# had to be started by hand every time.
#
# Set ANTON_DEPLOY_RELAUNCH=1 to restore the legacy quit+relaunch behavior.

set -u

HARNESS_ROOT="/Users/pankajdoharey/Development/Projects/ML/antoncode/deepseek-harness"
APP_BUNDLE="$HARNESS_ROOT/dist/Anton.app"
NEXT_BUNDLE="$HARNESS_ROOT/dist/Anton.next.app"
LOG="$HOME/Library/Application Support/Anton/deploy.log"

log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

log "deploy: starting; next=$NEXT_BUNDLE"

if [ ! -d "$NEXT_BUNDLE" ]; then
  log "deploy: ABORT — $NEXT_BUNDLE does not exist"
  exit 1
fi

if [ "${ANTON_DEPLOY_RELAUNCH:-0}" = "1" ]; then
  log "deploy: legacy relaunch mode — quitting Anton"
  osascript -e 'quit app "Anton"' >> "$LOG" 2>&1 || log "deploy: osascript quit returned non-zero (continuing)"
  for _ in $(seq 1 30); do
    pgrep -f 'deepseek-harness/dist/Anton.app/Contents/(MacOS/Anton|Resources/bin/anton-bridge|Resources/node/bin/node)' >/dev/null 2>&1 || break
    sleep 1
  done
  for p in $(pgrep -f 'deepseek-harness/dist/Anton.app/Contents/(MacOS/Anton|Resources/bin/anton-bridge|Resources/node/bin/node)' 2>/dev/null); do
    kill -9 "$p" 2>/dev/null || true
  done
  sleep 1
fi

log "deploy: swapping bundle in place"
if [ -d "$APP_BUNDLE" ]; then
  rm -rf "$APP_BUNDLE.old"
  mv "$APP_BUNDLE" "$APP_BUNDLE.old" || { log "deploy: ABORT — cannot move old bundle"; exit 1; }
fi
mv "$NEXT_BUNDLE" "$APP_BUNDLE" || { log "deploy: ABORT — cannot install new bundle"; exit 1; }
log "deploy: installed $APP_BUNDLE (in place)"

if [ "${ANTON_DEPLOY_RELAUNCH:-0}" = "1" ]; then
  log "deploy: launching"
  open "$APP_BUNDLE"
else
  log "deploy: bundle installed; waiting for the in-app restart (Restart Harness / anton_restart) to activate it"
fi

log "deploy: waiting for services"
web=000 bridge=000
for _ in $(seq 1 60); do
  web=$(curl -fsS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/ 2>/dev/null || echo 000)
  bridge=$(curl -fsS --max-time 2 -o /dev/null -w '%{http_code}' http://antoncode.localhost:3742/bridge 2>/dev/null || echo 000)
  if [ "$web" = "200" ] && [ "$bridge" = "200" ]; then
    health=$(curl -fsS --max-time 2 http://127.0.0.1:8090/health 2>/dev/null || echo '{}')
    log "deploy: READY web=$web bridge=$bridge c0ntext=$health"
    exit 0
  fi
  sleep 2
done

log "deploy: WARN — services not fully ready within timeout (web=$web bridge=$bridge)"
exit 2
