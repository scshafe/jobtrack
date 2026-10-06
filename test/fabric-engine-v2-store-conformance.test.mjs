// test/fabric-engine-v2-store-conformance.test.mjs — the engine's OWN store
// contract, run against JobTrack's SqliteUnitStore (docs/V2-ENGINE-PORT.md §3).
//
// mission-pipeline 1.0.0 ships executable conformance suites for the UnitStore
// and GraphStore ports (the memory stores are the oracle). Registering them here
// is what makes "consumer-owned SQLite adapter" a claim with teeth: every
// scenario the inbox Postgres adapter must pass, this one passes too —
// including the settle-checkpoint crash + recover cases, which reopen the store
// on the same database file and expect the engine's committed state exactly.
//
// ESM on purpose: the suites register node:test cases synchronously after a
// top-level await of the vendored (byte-pinned) engine.

import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const vendorPin = require("../lib/draft-runner/vendor-pin");
const { SqliteUnitStore } = require("../lib/engine-v2/sqlite-unit-store");

const mp = await vendorPin.loadMissionPipeline();
const root = vendorPin.vendorRoot("mission-pipeline");
const { registerUnitStoreConformanceTests } = await import(`file://${join(root, "lib", "store", "unit-store-conformance.js")}`);
const { registerGraphStoreConformanceTests } = await import(`file://${join(root, "lib", "store", "graph-store-conformance.js")}`);

const EPOCH = Date.parse("2026-09-01T00:00:00.000Z");

/** A deterministic clock the driver can advance. */
function clock() {
  let at = EPOCH;
  return {
    now: () => new Date(at),
    advance: (milliseconds) => { at += milliseconds; }
  };
}

function openDatabase(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  return db;
}

registerGraphStoreConformanceTests({
  backendName: "jobtrack SqliteUnitStore (graph store)",
  createDriver: () => {
    const dir = mkdtempSync(join(tmpdir(), "jobtrack-v2-graph-conformance-"));
    const db = openDatabase(join(dir, "evidence.db"));
    const store = new SqliteUnitStore({ db, mp });
    return {
      graphStore: store,
      async close() {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }
});

registerUnitStoreConformanceTests({
  backendName: "jobtrack SqliteUnitStore",
  createDriver: () => {
    const dir = mkdtempSync(join(tmpdir(), "jobtrack-v2-unit-conformance-"));
    const file = join(dir, "evidence.db");
    const time = clock();
    const hits = [];
    let armed = null;
    let sequence = 0;
    const idFactory = (kind) => `${kind}:${String(++sequence).padStart(6, "0")}`;
    const settleCheckpoint = (checkpoint) => {
      hits.push(checkpoint);
      if (armed === checkpoint) {
        armed = null;
        throw new Error(`armed settle crash at ${checkpoint}`);
      }
    };
    let db = openDatabase(file);
    const open = () => new SqliteUnitStore({ db, mp, now: time.now, idFactory, settleCheckpoint });
    let store = open();
    const driver = {
      get graphStore() { return store; },
      get unitStore() { return store; },
      now: () => time.now(),
      advanceClock: (milliseconds) => time.advance(milliseconds),
      armSettleCrash: (checkpoint) => { armed = checkpoint; },
      async recover() {
        // A fresh process over the same database: whatever SQLite committed is
        // the whole truth; in-memory state from the crashed operation is gone.
        db.close();
        db = openDatabase(file);
        store = open();
      },
      checkpointHits: () => [...hits],
      async evidence() {
        const snapshot = await store.evidenceSnapshot();
        return {
          artifacts: snapshot.artifacts,
          queues: snapshot.queues,
          journey: snapshot.journey,
          joins: snapshot.joins,
          cachedCompletions: snapshot.cachedCompletions.map((row) => ({ queueId: row.queueId, completionDigest: row.completionDigest })),
          settlements: snapshot.settlements.map((row) => ({ queueId: row.queueId, settlementDigest: row.settlementDigest })),
          outbox: snapshot.outbox,
          deadLetters: snapshot.deadLetters,
          leases: snapshot.leases.map((row) => ({ queueId: row.queueId, lease: { leaseToken: row.lease.leaseToken } }))
        };
      },
      async close() {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    };
    return driver;
  }
});
