#!/bin/sh
# scripts/fabric-worker-service.sh — the jobtrack-worker container's entrypoint
# (Dockerfile.worker; infra stacks/jobtrack, compose profile `worker`).
#
# The production write side as a stack service: the `fabric daemon` running
# `fabric dispatch --notify` on the real store, the job the Mac mini's
# com.cole.jobtrack-fabric-daemon LaunchAgent runs today
# (docs/move-write-side-to-lubuntu.md). The daemon wakes on its socket
# (<store>/fabric.sock), on the fabric's due-at, and on a 20-minute safety
# tick; on SIGTERM it stops admitting passes and waits for the current one.
#
# It refuses to start, exit 78, instead of guessing:
#   * JOBTRACK_HOME must be a writable directory that already holds
#     jobtrack.db. A wrong bind mount would otherwise cold-initialise a
#     second, empty store and run the pipeline on it.
#   * Staffing workers needs the Codex login: $CODEX_HOME/auth.json, made by
#     the owner (`codex login --device-auth`). Without it every staffed item
#     would burn its dispatch budget on infra errors. A pass with --dry-run
#     (JOBTRACK_DISPATCH_ARGS) stages nothing and needs no login.
#
# Environment (the image sets the defaults):
#   JOBTRACK_HOME           the store, bind-mounted read-write
#   CODEX_HOME              the worker's own Codex home (auth.json; config.toml
#                           is rewritten from the image at every start)
#   JOBTRACK_DISPATCH_ARGS  the pass's dispatch flags
#                           (default: --max-workers 3 --notify --json)
#   JOBTRACK_SAFETY_TICK_MS the daemon's level-triggered backstop (1200000)
#   JOBTRACK_NTFY_TOPIC     parked-gate notifications; unset = none
set -eu

ROOT=/app
NODE="${JOBTRACK_NODE_PATH:-/usr/local/bin/node}"
STORE="${JOBTRACK_HOME:?JOBTRACK_HOME must name the store}"
ARGS="${JOBTRACK_DISPATCH_ARGS:---max-workers 3 --notify --json}"
SAFETY_TICK_MS="${JOBTRACK_SAFETY_TICK_MS:-1200000}"

refuse() { echo "fabric-worker-service: $*" >&2; exit 78; }

[ -d "$STORE" ] && [ -w "$STORE" ] || refuse "JOBTRACK_HOME=$STORE is not a writable directory"
[ -f "$STORE/jobtrack.db" ] || refuse "no jobtrack.db in $STORE; refusing to initialise a new store"

case " $ARGS " in
  *" --dry-run "*) ;;
  *)
    : "${CODEX_HOME:?CODEX_HOME must name the Codex home of the worker}"
    [ -s "$CODEX_HOME/auth.json" ] || refuse "no Codex login in CODEX_HOME ($CODEX_HOME/auth.json); see docs/move-write-side-to-lubuntu.md, owner steps"
    ;;
esac

# The worker's Codex settings are versioned with the code (the Mini's workers
# inherited the owner's interactive ~/.codex/config.toml, plugins and MCP
# servers included). Only auth.json in CODEX_HOME is the owner's.
if [ -n "${CODEX_HOME:-}" ] && [ -d "$CODEX_HOME" ] && [ -w "$CODEX_HOME" ]; then
  cp "$ROOT/deploy/worker/codex-config.toml" "$CODEX_HOME/config.toml.new"
  chmod 600 "$CODEX_HOME/config.toml.new"
  mv -f "$CODEX_HOME/config.toml.new" "$CODEX_HOME/config.toml"
fi

echo "fabric-worker-service: store $STORE; pass: fabric dispatch $ARGS; safety tick ${SAFETY_TICK_MS}ms" >&2
exec "$NODE" "$ROOT/bin/jobtrack.js" fabric daemon \
  --pass-command "cd $ROOT && $NODE bin/jobtrack.js fabric dispatch $ARGS" \
  --safety-tick-ms "$SAFETY_TICK_MS"
