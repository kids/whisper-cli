#!/bin/bash
# Canonical copy of the launchd wrapper. Install:
#   cp scripts/whisper-feishu-start.sh "$HOME/Library/Application Support/whisper-feishu/start.sh"
#   cp com.r.whisper-feishu.plist "$HOME/Library/LaunchAgents/"
#   launchctl bootout "gui/$(id -u)/com.r.whisper-feishu" 2>/dev/null || true
#   launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.r.whisper-feishu.plist"
#   launchctl kickstart -k "gui/$(id -u)/com.r.whisper-feishu"
set -uo pipefail

APP="/Volumes/code/dev/whisper-cli"
ENV_FILE="/Users/r/devenv/whisper-cli.env"
LOG="/tmp/whisper-feishu.log"
NODE="/usr/local/bin/node"
TSX="$APP/node_modules/tsx/dist/cli.mjs"
MAIN="$APP/src/index.ts"
NODE_PID=""

export HOME="/Users/r"
export PATH="/Users/r/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NSAppSleepDisabled=YES
export AGENT_CLI_CREDENTIAL_STORE=file
export PYTHONUNBUFFERED=1
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--trace-uncaught"

log() { echo "[$(date '+%F %T')] whisper-feishu: $*" >>"$LOG"; }

on_exit() {
  local code=$?
  if (( code >= 128 )); then
    log "exited signal=$((code - 128)) raw=$code"
  else
    log "exited code=$code"
  fi
}
trap on_exit EXIT

on_term() {
  log "wrapper received SIGTERM"
  if [[ -n "${NODE_PID}" ]] && kill -0 "$NODE_PID" 2>/dev/null; then
    kill -TERM "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi
  exit 143
}
trap on_term TERM INT

for _ in $(seq 1 90); do
  if [[ -f "$MAIN" && -f "$TSX" && -x "$NODE" ]]; then
    break
  fi
  sleep 2
done

if [[ ! -f "$MAIN" || ! -f "$TSX" ]]; then
  log "PSSD app missing at $APP"
  exit 1
fi

if [[ ! -r "$ENV_FILE" ]]; then
  log "missing readable env at $ENV_FILE"
  exit 1
fi

cd "$APP" || { log "cd $APP failed"; exit 1; }
set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a

log "starting via launchd wrapper (env=$ENV_FILE node=$("$NODE" -v 2>/dev/null || echo ?) pid=$$)"

set +e
"$NODE" "$TSX" "$MAIN" &
NODE_PID=$!
wait "$NODE_PID"
code=$?
set -e
exit "$code"
