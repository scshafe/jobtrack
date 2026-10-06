#!/bin/sh
# scripts/conductor-gate.sh — the release gate the Conductor runs before and
# after deploying this repository (docs/VERIFICATION.md, "Standing release
# gates"). The manifest names ONE verb per stage; the logic lives here so the
# manifest stays a list of commands and the gate can be run by hand.
#
#   install                     dev dependencies for the checkout (npm ci only
#                               when package-lock.json changed since the last
#                               install, so a run costs seconds, not minutes)
#   test                        the whole suite, NODE_ENV unset
#   test-shard I N              slice I of N of the suite (1 <= I <= N): the
#                               files `node --test` discovers, in `git ls-files`
#                               order, every Nth from the Ith. The Conductor
#                               caps each command at ten minutes and the whole
#                               suite takes nearly that on Lubuntu, so the
#                               manifest runs the suite as N slices instead
#   test-shard-list I N         print slice I of N's files, one per line
#   export-contract STORE_DIR   the public-export gate: copy the replica of
#                               the live store to a scratch directory, run
#                               `jobtrack export public-profile` there; the
#                               command fails closed on any contract or
#                               redaction violation, and its exit status is
#                               the verdict
#   verify HEALTH_URL SIDECAR   after deploy: the health URL answers 200 and
#                               the tailscale sidecar serves the app to the
#                               tailnet only (Funnel off)
#
# Every verb runs from the repository root; the Conductor runs it there via
# /bin/sh -c with a ten-minute cap per command.
set -eu
cd "$(dirname "$0")/.."
verb="${1:-}"
shift || true

lock_stamp() { sha256sum package-lock.json | cut -c1-64; }

# The tracked files `node --test` (no arguments) runs: its default patterns
# under the repository root, minus node_modules.
test_files() {
  git ls-files | grep -E '(^|/)test/.*\.[cm]?js$|\.test\.[cm]?js$|-test\.[cm]?js$|_test\.[cm]?js$|(^|/)test-[^/]*\.[cm]?js$|(^|/)test\.[cm]?js$' \
    | grep -Ev '(^|/)node_modules/' || true
}

shard_files() {
  case "$1" in ''|*[!0-9]*) echo "conductor-gate: slice index must be a number, got '$1'" >&2; exit 64 ;; esac
  case "$2" in ''|*[!0-9]*) echo "conductor-gate: slice count must be a number, got '$2'" >&2; exit 64 ;; esac
  if [ "$2" -lt 1 ] || [ "$1" -lt 1 ] || [ "$1" -gt "$2" ]; then
    echo "conductor-gate: need 1 <= I <= N, got I=$1 N=$2" >&2; exit 64
  fi
  test_files | awk -v i="$1" -v n="$2" '(NR - 1) % n == i - 1'
}

case "$verb" in
  install)
    # The Conductor links node_modules to the primary checkout's so installs
    # persist across runs; make that target exist before installing into it.
    if [ -L node_modules ] && [ ! -e node_modules ]; then mkdir -p "$(readlink node_modules)"; fi
    stamp_file=node_modules/.conductor-lock-sha256
    if [ -d node_modules ] && [ "$(cat "$stamp_file" 2>/dev/null || true)" = "$(lock_stamp)" ] \
       && node -e "require('better-sqlite3')" >/dev/null 2>&1; then
      echo "conductor-gate: node_modules matches package-lock.json; install skipped"
    else
      env -u NODE_ENV npm ci --no-audit --no-fund
      lock_stamp > "$stamp_file"
    fi
    node -e "require('better-sqlite3')"
    echo "conductor-gate: install ok ($(node -v))"
    ;;
  test)
    env -u NODE_ENV npm test
    ;;
  test-shard-list)
    shard_files "${1:-}" "${2:-}"
    ;;
  test-shard)
    files="$(shard_files "${1:-}" "${2:-}")"
    if [ -z "$files" ]; then
      echo "conductor-gate: slice ${1}/${2} has no test files"
      exit 0
    fi
    echo "conductor-gate: slice ${1}/${2}: $(printf '%s\n' "$files" | wc -l | tr -d ' ') test file(s)"
    # shellcheck disable=SC2086  # one path per word; tracked test paths have no spaces
    env -u NODE_ENV node --test $files
    ;;
  export-contract)
    store="${1:?export-contract needs the replica store directory}"
    # Validate the original source before copying: validating only the resulting
    # temporary path would discard protected-source provenance.
    node -e "require('./lib/private-source-boundary').assertPathNotPrivateJournalSource(process.argv[1])" "$store"
    [ -f "$store/jobtrack.db" ] || { echo "conductor-gate: no store at $store" >&2; exit 2; }
    scratch="$(mktemp -d "${TMPDIR:-/tmp}/jobtrack-export-gate.XXXXXX")"
    trap 'rm -rf "$scratch"' EXIT
    # A copy, never the store itself: the CLI may migrate the store it opens,
    # and the store is the read-only truth the web container serves. The
    # database goes through SQLite's online backup, never a byte copy: once
    # the write side runs on this host the source is the LIVE store, with
    # writers (docs/move-write-side-to-lubuntu.md). Only what the export can
    # read crosses: the database and the attachment tree.
    mkdir -m 700 "$scratch/store"
    node scripts/lib/store-snapshot.cjs "$(cd "$store" && pwd)/jobtrack.db" "$scratch/store/jobtrack.db"
    if [ -d "$store/attachments" ]; then cp -R "$store/attachments" "$scratch/store/attachments"; fi
    chmod -R u+rwX "$scratch/store"
    JOBTRACK_HOME="$scratch/store" JOBTRACK_DB="$scratch/store/jobtrack.db" env -u NODE_ENV node bin/jobtrack.js export public-profile \
      --out "$scratch/public-profile.json" --json > "$scratch/export.log"
    node -e "
      const fs = require('node:fs');
      const out = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      const artifact = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
      const summary = { contract: artifact.contract, contractVersion: artifact.contractVersion, bytes: out.bytes, sha256: String(out.sha256).slice(0, 12) };
      console.log('conductor-gate: export contract ok', JSON.stringify(summary));
    " "$scratch/export.log" "$scratch/public-profile.json"
    ;;
  verify)
    url="${1:?verify needs the health URL}"
    sidecar="${2:?verify needs the tailscale sidecar container name}"
    curl -fsS --max-time 8 "$url" > /dev/null
    status="$(docker exec "$sidecar" tailscale funnel status 2>&1)"
    host="$(printf '%s' "$url" | sed -E 's#^https?://([^/]+).*#\1#')"
    printf '%s\n' "$status" | grep -q "^https://$host (tailnet only)" \
      || { echo "conductor-gate: $sidecar does not serve https://$host tailnet-only:" >&2; printf '%s\n' "$status" >&2; exit 1; }
    if printf '%s\n' "$status" | grep -qi "funnel on"; then
      echo "conductor-gate: Funnel is ON for $host — the standing gate forbids it" >&2
      printf '%s\n' "$status" >&2
      exit 1
    fi
    echo "conductor-gate: verify ok — $url 200, $host tailnet only"
    ;;
  *)
    echo "usage: scripts/conductor-gate.sh install|test|test-shard I N|test-shard-list I N|export-contract STORE_DIR|verify HEALTH_URL SIDECAR" >&2
    exit 64
    ;;
esac
