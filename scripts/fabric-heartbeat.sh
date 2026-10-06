#!/bin/sh
# scripts/fabric-heartbeat.sh — the jobtrack-heartbeat container's command
# (Dockerfile.worker; infra stacks/jobtrack, compose profile `worker`).
#
# Runs scripts/fabric-cron.sh (one bounded tick, then queue.md, last-tick.json
# and tick-log.jsonl under $JOBTRACK_HOME/fabric/) once at start and then every
# JOBTRACK_HEARTBEAT_SECONDS (default 3600): the hourly
# com.cole.jobtrack-fabric LaunchAgent of the Mac mini, as a stack service.
# A run in progress finishes before SIGTERM is honoured; the sleep between
# runs is interruptible. Same store guard as fabric-worker-service.sh.
set -eu

STORE="${JOBTRACK_HOME:?JOBTRACK_HOME must name the store}"
INTERVAL="${JOBTRACK_HEARTBEAT_SECONDS:-3600}"
case "$INTERVAL" in ''|*[!0-9]*) echo "fabric-heartbeat: JOBTRACK_HEARTBEAT_SECONDS must be a whole number" >&2; exit 78 ;; esac
[ -d "$STORE" ] && [ -w "$STORE" ] || { echo "fabric-heartbeat: JOBTRACK_HOME=$STORE is not a writable directory" >&2; exit 78; }
[ -f "$STORE/jobtrack.db" ] || { echo "fabric-heartbeat: no jobtrack.db in $STORE; refusing to initialise a new store" >&2; exit 78; }

stop=0
sleeper=
trap 'stop=1; [ -z "$sleeper" ] || kill "$sleeper" 2>/dev/null || true' TERM INT

while [ "$stop" = 0 ]; do
  sh /app/scripts/fabric-cron.sh || echo "fabric-heartbeat: fabric-cron.sh exited $?" >&2
  [ "$stop" = 0 ] || break
  sleep "$INTERVAL" &
  sleeper=$!
  wait "$sleeper" 2>/dev/null || true
  sleeper=
done
