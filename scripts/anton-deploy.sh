#!/bin/bash
# anton-deploy.sh — detached deploy daemon.
#
# Installs dist/Anton.next.app as the live Anton.app and relaunches it, then
# verifies the whole stack. Designed to be run detached (nohup ... &) so it
# survives the Harness session going down during the restart.
#
# Usage:
#   nohup bash scripts/anton-deploy.sh >> "$HOME/Library/Application Support/Anton/deploy.log" 2>&1 &

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

# Grace period so the launching agent's final message flushes before the app
# (and the Harness session running it) is torn down.
sleep 6

log "deploy: quitting Anton gracefully"
osascript -e 'quit app "Anton"' >> "$LOG" 2>&1 || log "deploy: osascript quit returned non-zero (continuing)"

log "deploy: waiting for processes to exit"
for _ in $(seq 1 30); do
  if ! pgrep -f 'deepseek-harness/dist/Anton.app/Contents/(MacOS/Anton|Resources/bin/anton-bridge|Resources/node/bin/node)' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
for p in $(pgrep -f 'deepseek-harness/dist/Anton.app/Contents/(MacOS/Anton|Resources/bin/anton-bridge|Resources/node/bin/node)' 2>/dev/null); do
  kill -9 "$p" 2>/dev/null || true
done
sleep 1

log "deploy: swapping bundle"
if [ -d "$APP_BUNDLE" ]; then
  rm -rf "$APP_BUNDLE.old"
  mv "$APP_BUNDLE" "$APP_BUNDLE.old" || { log "deploy: ABORT — cannot move old bundle"; exit 1; }
fi
mv "$NEXT_BUNDLE" "$APP_BUNDLE" || { log "deploy: ABORT — cannot install next bundle"; exit 1; }
log "deploy: installed $APP_BUNDLE"

log "deploy: launching"
open "$APP_BUNDLE"

log "deploy: waiting for services"
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
