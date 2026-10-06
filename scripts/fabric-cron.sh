#!/bin/sh
# scripts/fabric-cron.sh — the standing fabric heartbeat (FABRIC_PLAN Phase E).
#
# One bounded tick against the REAL store, then refresh the operator queue.
# With every gate at its fail-closed human default, the tick performs only
# safe deterministic work (renders/lint when Docker is up, packaging and
# proposing only downstream of human approvals); everything needing a person
# lands in ~/.jobtrack/fabric/queue.md — the daily driver.
#
# Outputs (all under $JOBTRACK_HOME/fabric/):
#   last-tick.json   the full tick result of the most recent run
#   tick-log.jsonl   one summary line per run (append-only history)
#   queue.md         the current operator queue, human-readable
#   cron.err         stderr from the two jobtrack invocations
#
# Installed via deploy/launchd/com.cole.jobtrack-fabric.plist (hourly).

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${JOBTRACK_NODE_PATH:-$HOME/.openclaw/tools/node/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node)"
STORE="${JOBTRACK_HOME:-$HOME/.jobtrack}"
OUT="$STORE/fabric"
mkdir -p "$OUT"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

TICK_JSON="$(JOBTRACK_HOME="$STORE" "$NODE" "$ROOT/bin/jobtrack.js" fabric tick --json 2>>"$OUT/cron.err" || printf '{}')"
printf '%s\n' "$TICK_JSON" > "$OUT/last-tick.json"
printf '%s' "$TICK_JSON" | "$NODE" -e '
  let raw = "";
  process.stdin.on("data", (c) => { raw += c; });
  process.stdin.on("end", () => {
    let line;
    try {
      const tick = JSON.parse(raw);
      line = { at: process.argv[1], ...(tick.summary ?? { error: "no summary" }) };
    } catch (error) {
      line = { at: process.argv[1], error: "tick output unparseable" };
    }
    console.log(JSON.stringify(line));
  });
' "$STAMP" >> "$OUT/tick-log.jsonl"

JOBTRACK_HOME="$STORE" "$NODE" "$ROOT/bin/jobtrack.js" fabric next --json 2>>"$OUT/cron.err" \
  | "$NODE" "$ROOT/scripts/fabric-queue.js" > "$OUT/queue.md"
