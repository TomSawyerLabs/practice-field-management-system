#!/bin/bash -e

# Ensure bun is in PATH (installed at ~/.bun/bin by default)
export PATH="$HOME/.bun/bin:$PATH"

FORCE=false
CLEAN=false

for arg in "$@"; do
  case "$arg" in
    clean) CLEAN=true ;;
    force) FORCE=true ;;
    continue) ;; # handled below
  esac
done

if $CLEAN; then
  rm -rf node_modules
fi

# One deploy at a time. Two runs that overlapped (2026-09-18 17:59, five
# seconds apart) each rebuilt and reloaded the backend, so every screen on the
# field reloaded twice. The lock lives on fd 9, which survives the re-exec
# below, so the 'continue' pass inherits it instead of taking it again. A
# second run waits its turn; once it gets the lock it pulls whatever is newest
# and, if the backend is already on that commit, skips the reload (see below).
LOCK_FILE=${PFMS_UPDATE_LOCK:-/tmp/pfms-update.lock}
if [[ ! " $* " =~ " continue " ]]; then
  exec 9>>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "⏳ Another deploy is already running — waiting for it to finish..."
    flock 9
    echo "✅ Previous deploy finished — continuing with this one."
  fi
fi

# Run the latest version of this script after updating
if [[ ! " $* " =~ " continue " ]]; then
  git pull
  # Forward all original args plus 'continue'
  exec "$(realpath "$0")" continue "$@"
fi

bun install

bun run build

DEPLOY_BASE=${PFMS_DEPLOY_BASE:-/opt/practice-field-management-system}
SERVICE=${PFMS_SERVICE:-practice-field-management-system.service}
ENV_FILE=${PFMS_ENV_FILE:-/etc/pfms/environment}

# The health check below decides whether a match is running, so it has to hit
# the port the service actually listens on. Read it from the service's own
# environment file rather than assuming — a mismatch used to fail silently:
# curl got nothing, the phase read as "unknown", the match guard never engaged,
# and the deploy reloaded straight through a live match.
if [ -z "$WEBSOCKET_PORT" ] && [ -r "$ENV_FILE" ]; then
  WEBSOCKET_PORT=$(sed -n 's/^[[:space:]]*WEBSOCKET_PORT[[:space:]]*=[[:space:]]*\([0-9]\{1,5\}\).*/\1/p' "$ENV_FILE" | tail -n1)
fi
PORT=${WEBSOCKET_PORT:-3000}

echo "Deploying to $DEPLOY_BASE"

# Synchronize the internal directory with the frontend build output
rsync -av --delete frontend/dist/ $DEPLOY_BASE/internal/

# Deploy sound files so the browser can play match audio
rsync -av sounds/ $DEPLOY_BASE/internal/sounds/

# Copy the public.html to the public directory
cp frontend/src/public.html $DEPLOY_BASE/public/index.html

# Helper: read one field of the backend's /health JSON ("unknown" if it's down)
get_health_field() {
  curl -sf "http://localhost:$PORT/health" 2>/dev/null \
    | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).$1 ?? 'unknown'" 2>/dev/null \
    || echo "unknown"
}

# Helper: get the current match phase from the backend
get_match_phase() {
  get_health_field phase
}

# Nothing to restart if the backend already runs the commit we just deployed —
# typically a second deploy queued behind the lock above. The files were still
# synced (the same content), so a stale frontend can't hide behind this; only
# the disruptive part is skipped. './update.sh force' reloads regardless, e.g.
# after changing the environment file.
HEAD_VERSION=$(git rev-parse --short HEAD)
RUNNING_VERSION=$(get_health_field version)
if [ "$RUNNING_VERSION" = "$HEAD_VERSION" ] && ! $FORCE; then
  echo ""
  echo "✅ Backend is already running $HEAD_VERSION — files synced, no reload needed."
  echo "   (use './update.sh force' to reload anyway)"
  exit 0
fi

# Phases where robots are under field control or scores are still counting —
# reloading would interrupt a live match, so wait these out. Everything else
# ('idle', 'created' while teams set up, 'unknown' when the server is down)
# is safe to reload through: worst case, joined teams re-join after the
# deploy. 'created' must NOT block — it never expires on its own, so waiting
# on it hangs the deploy indefinitely.
is_active_phase() {
  case "$1" in
    countdown | auto | autoPause | paused | teleop | endgame | postMatch) return 0 ;;
    *) return 1 ;;
  esac
}

# Wait for any active match to finish before reloading
MATCH_PHASE=$(get_match_phase)

if is_active_phase "$MATCH_PHASE"; then
  if $FORCE; then
    echo "⚠️  Match in progress (phase: $MATCH_PHASE) — forcing reload (--force)"
  else
    # A normal match runs ~3 minutes plus a 2-minute postMatch counting
    # period, so 10 minutes covers back-to-back finishes. A match paused
    # indefinitely would otherwise hold the deploy forever.
    MAX_WAIT=600
    WAITED=0
    echo ""
    echo "⏳ Match in progress (phase: $MATCH_PHASE) — waiting up to $((MAX_WAIT / 60)) minutes for it to finish..."
    echo "   (use './update.sh force' to skip this wait)"
    echo ""
    while true; do
      sleep 5
      WAITED=$((WAITED + 5))
      MATCH_PHASE=$(get_match_phase)
      if ! is_active_phase "$MATCH_PHASE"; then
        echo "✅ Match finished (phase: $MATCH_PHASE) — proceeding with reload."
        break
      fi
      if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        echo ""
        echo "❌ Gave up after $((MAX_WAIT / 60)) minutes — the field is still in use (phase: $MATCH_PHASE)."
        echo ""
        echo "   The backend was NOT reloaded, but the new frontend is already synced and"
        echo "   being served against the old backend — finish the deploy soon to avoid a"
        echo "   version mismatch:"
        echo "     ./update.sh          try again (waits for the field to free up)"
        echo "     ./update.sh force    reload now (interrupts the match in progress)"
        exit 1
      fi
      echo "   Still waiting... (phase: $MATCH_PHASE, ${WAITED}s elapsed)"
    done
  fi
fi

echo "Reloading $SERVICE"
sudo systemctl reload-or-restart "$SERVICE"
echo "Watching startup logs (10s)..."
timeout 10 journalctl -u "$SERVICE" -f -n 0 --no-pager &
JOURNAL_PID=$!
# Wait a moment, then check if the service is still running
sleep 3
if ! systemctl is-active --quiet "$SERVICE"; then
  echo ""
  echo "ERROR: $SERVICE failed to start!"
  echo "Last logs:"
  journalctl -u "$SERVICE" -n 20 --no-pager
  kill $JOURNAL_PID 2>/dev/null || true
  exit 1
fi
wait $JOURNAL_PID 2>/dev/null || true
