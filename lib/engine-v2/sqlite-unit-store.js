'use strict';

// SqliteUnitStore — JobTrack's consumer-owned durable adapter for the Mission
// Pipeline v2 engine's UnitStore + GraphStore ports (docs/V2-ENGINE-PORT.md §3).
//
// mission-pipeline ships `MemoryUnitStore` as the executable specification of
// the store contract and expects consumers to own durable adapters (inbox owns
// a Postgres one whose N4 design hydrates the store state per operation and
// persists a delta). This adapter follows that shape at SQLite scale:
//
//   one operation = one `BEGIN IMMEDIATE … COMMIT`:
//     load every published graph into a MemoryGraphStore,
//     load the scope's MemoryUnitStoreStateSnapshot from engine_unit_state,
//     run the operation on the hydrated MemoryUnitStore,
//     persist the new snapshot + the evidence projections
//       (engine_journey, engine_outbox, engine_dead_letters),
//     commit — and rethrow whatever the operation threw.
//
// The memory store's own transaction discipline decides what the persisted
// state is: a throw before a settle checkpoint has rolled the memory state
// back (we persist the unchanged snapshot); a throw at `post_commit_reply` has
// already committed it (we persist the advanced snapshot). Either way SQLite
// commits exactly the state the engine considers durable.
//
// SCOPE. A store opened with `scope: <unitId>` holds one partition: exactly
// that unit's state. The fabric worker runner uses this so `runNextUnitTurn`
// can only ever claim the runner's own unit — a stale queue left by a crashed
// sibling process is never picked up by a different request. `scope: "*"`
// (the default) is the whole-store partition the conformance suites drive.
// Cross-scope reads (listOutboxEvents / listDeadLetters without a unitId)
// union every partition read-only.
//
// CONCURRENCY. Operations are serialised in-process through a promise chain
// and across processes by SQLite's write lock (busy_timeout), so two runners
// on the same evidence database never lose an update.
//
// WHAT THIS IS NOT. A partition's snapshot is rewritten per operation; this is
// not a relational unit store. Bounded here by the one-unit scope; a consumer
// that needs cross-unit fairness over thousands of queued units in one scope
// needs the working-set scoping inbox's F1 follow-up describes.

const ALL_SCOPE = '*';
const BUSY_TIMEOUT_MS = 10_000;

const SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS engine_graphs (
     graph_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     digest TEXT NOT NULL,
     definition_json TEXT NOT NULL,
     published_at TEXT NOT NULL,
     PRIMARY KEY (graph_id, version)
   )`,
  `CREATE TABLE IF NOT EXISTS engine_unit_state (
     scope TEXT PRIMARY KEY,
     snapshot_json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS engine_journey (
     unit_id TEXT NOT NULL,
     sequence INTEGER NOT NULL,
     kind TEXT NOT NULL,
     node_id TEXT,
     outcome TEXT,
     error_code TEXT,
     recorded_at TEXT NOT NULL,
     record_digest TEXT NOT NULL,
     record_json TEXT NOT NULL,
     PRIMARY KEY (unit_id, sequence)
   )`,
  `CREATE TABLE IF NOT EXISTS engine_outbox (
     outbox_event_id TEXT PRIMARY KEY,
     unit_id TEXT NOT NULL,
     node_id TEXT NOT NULL,
     event_type TEXT NOT NULL,
     recorded_at TEXT NOT NULL,
     record_json TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS engine_dead_letters (
     dead_letter_id TEXT PRIMARY KEY,
     unit_id TEXT NOT NULL,
     node_id TEXT NOT NULL,
     error_code TEXT NOT NULL,
     recorded_at TEXT NOT NULL,
     record_json TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS engine_journey_by_unit ON engine_journey (unit_id, sequence)',
  'CREATE INDEX IF NOT EXISTS engine_outbox_by_unit ON engine_outbox (unit_id, recorded_at)',
  'CREATE INDEX IF NOT EXISTS engine_dead_letters_by_unit ON engine_dead_letters (unit_id, recorded_at)'
]);

const UNIT_STORE_METHODS = Object.freeze([
  'admitUnit', 'readUnit', 'readJourney', 'readJoinProgress', 'listQueuedUnits', 'getArtifact',
  'claimUnitTurns', 'heartbeatTurn', 'prepareTurnAttempt', 'cacheTurnCompletion',
  'recordTurnFailure', 'settleTurn', 'inspectExternalUnitTurn', 'claimExternalUnitTurn'
]);

class SqliteUnitStore {
  #db;
  #mp;
  #scope;
  #now;
  #idFactory;
  #settleCheckpoint;
  #queue = Promise.resolve();
  #statements;

  /**
   * @param {{ db: import('better-sqlite3').Database, mp: object, scope?: string,
   *   now?: () => Date, idFactory?: Function, settleCheckpoint?: Function }} options
   *   `mp` is the imported mission-pipeline 1.0.0 module namespace (the vendored, pinned tree).
   */
  constructor(options) {
    if (!options || typeof options !== 'object') throw new TypeError('SqliteUnitStore needs an options object');
    if (!options.db || typeof options.db.prepare !== 'function') throw new TypeError('SqliteUnitStore needs a better-sqlite3 database');
    if (!options.mp || typeof options.mp.MemoryUnitStore !== 'function' || typeof options.mp.MemoryGraphStore !== 'function') {
      throw new TypeError('SqliteUnitStore needs the mission-pipeline module namespace (MemoryUnitStore, MemoryGraphStore)');
    }
    this.#db = options.db;
    this.#mp = options.mp;
    this.#scope = options.scope === undefined ? ALL_SCOPE : String(options.scope);
    if (this.#scope.length === 0) throw new TypeError('SqliteUnitStore scope must be a non-empty string');
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory;
    this.#settleCheckpoint = options.settleCheckpoint;
    this.#db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    for (const statement of SCHEMA_SQL) this.#db.exec(statement);
    this.#statements = {
      graphs: this.#db.prepare('SELECT definition_json FROM engine_graphs ORDER BY published_at, graph_id, version'),
      upsertGraph: this.#db.prepare('INSERT OR REPLACE INTO engine_graphs (graph_id, version, digest, definition_json, published_at) VALUES (?, ?, ?, ?, ?)'),
      snapshot: this.#db.prepare('SELECT snapshot_json FROM engine_unit_state WHERE scope = ?'),
      scopes: this.#db.prepare('SELECT scope FROM engine_unit_state ORDER BY scope'),
      upsertSnapshot: this.#db.prepare('INSERT OR REPLACE INTO engine_unit_state (scope, snapshot_json, updated_at) VALUES (?, ?, ?)'),
      upsertJourney: this.#db.prepare('INSERT OR REPLACE INTO engine_journey (unit_id, sequence, kind, node_id, outcome, error_code, recorded_at, record_digest, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      upsertOutbox: this.#db.prepare('INSERT OR REPLACE INTO engine_outbox (outbox_event_id, unit_id, node_id, event_type, recorded_at, record_json) VALUES (?, ?, ?, ?, ?, ?)'),
      upsertDeadLetter: this.#db.prepare('INSERT OR REPLACE INTO engine_dead_letters (dead_letter_id, unit_id, node_id, error_code, recorded_at, record_json) VALUES (?, ?, ?, ?, ?, ?)')
    };
    for (const method of UNIT_STORE_METHODS) {
      Object.defineProperty(this, method, {
        value: (...args) => this.#unitOperation((memory) => memory[method](...args)),
        enumerable: false,
        configurable: false,
        writable: false
      });
    }
    Object.freeze(this);
  }

  get scope() {
    return this.#scope;
  }

  // ---------------------------------------------------------------------------
  // GraphStore
  // ---------------------------------------------------------------------------

  publishGraph(graph) {
    return this.#serialize(() => this.#transaction(async () => {
      const graphStore = await this.#hydrateGraphStore();
      await graphStore.publishGraph(graph);
      const published = await graphStore.loadGraph({ id: graph.graphId, version: graph.version, digest: graph.graphDigest });
      this.#statements.upsertGraph.run(
        published.graphId, published.version, published.graphDigest, JSON.stringify(published), this.#timestamp()
      );
    }));
  }

  loadGraph(ref) {
    return this.#serialize(() => this.#transaction(async () => (await this.#hydrateGraphStore()).loadGraph(ref)));
  }

  // ---------------------------------------------------------------------------
  // Cross-scope evidence reads (the only reads that may span partitions)
  // ---------------------------------------------------------------------------

  listOutboxEvents(input) {
    if (this.#scope === ALL_SCOPE || (input && input.unitId !== undefined)) {
      return this.#unitOperation((memory) => memory.listOutboxEvents(input));
    }
    return this.#unionAcrossScopes((memory) => memory.listOutboxEvents(), input);
  }

  listDeadLetters(input) {
    if (this.#scope === ALL_SCOPE || (input && input.unitId !== undefined)) {
      return this.#unitOperation((memory) => memory.listDeadLetters(input));
    }
    return this.#unionAcrossScopes((memory) => memory.listDeadLetters(), input);
  }

  /** The persisted state of this scope, for adapters and tests (never for node bodies). */
  stateSnapshot() {
    return this.#serialize(() => this.#transaction(async () => {
      const memory = this.#hydrateUnitStore(this.#scope, await this.#hydrateGraphStore());
      return memory.stateSnapshot();
    }));
  }

  /** Engine evidence for this scope in the memory store's own shape. */
  evidenceSnapshot() {
    return this.#serialize(() => this.#transaction(async () => {
      const memory = this.#hydrateUnitStore(this.#scope, await this.#hydrateGraphStore());
      return memory.evidenceSnapshot();
    }));
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  #timestamp() {
    return this.#now().toISOString();
  }

  #serialize(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
      throw error;
    }
  }

  async #hydrateGraphStore() {
    const graphStore = new this.#mp.MemoryGraphStore();
    for (const row of this.#statements.graphs.all()) {
      await graphStore.publishGraph(JSON.parse(row.definition_json));
    }
    return graphStore;
  }

  #hydrateUnitStore(scope, graphStore) {
    const row = this.#statements.snapshot.get(scope);
    return new this.#mp.MemoryUnitStore({
      graphStore,
      now: this.#now,
      ...(this.#idFactory ? { idFactory: this.#idFactory } : {}),
      ...(this.#settleCheckpoint ? { settleCheckpoint: this.#settleCheckpoint } : {}),
      ...(row ? { initialState: JSON.parse(row.snapshot_json) } : {})
    });
  }

  #persist(scope, memory) {
    const snapshot = memory.stateSnapshot();
    const at = this.#timestamp();
    this.#statements.upsertSnapshot.run(scope, JSON.stringify(snapshot), at);
    for (const record of snapshot.journey) {
      this.#statements.upsertJourney.run(
        record.unitId, record.sequence, record.kind,
        record.nodeId ?? record.entryNodeId ?? null,
        record.outcome ?? null,
        record.errorCode ?? null,
        record.recordedAt, record.recordDigest, JSON.stringify(record)
      );
    }
    for (const event of snapshot.outbox) {
      this.#statements.upsertOutbox.run(
        event.outboxEventId, event.unitId, event.nodeId, event.eventType, event.recordedAt, JSON.stringify(event)
      );
    }
    for (const letter of snapshot.deadLetters) {
      this.#statements.upsertDeadLetter.run(
        letter.deadLetterId, letter.unitId, letter.nodeId, letter.errorCode, letter.recordedAt, JSON.stringify(letter)
      );
    }
  }

  /** One unit-store operation on the hydrated scope; the persisted state is whatever the engine committed. */
  #unitOperation(fn) {
    return this.#serialize(async () => {
      this.#db.exec('BEGIN IMMEDIATE');
      let result;
      let failure;
      let threw = false;
      try {
        const graphStore = await this.#hydrateGraphStore();
        const memory = this.#hydrateUnitStore(this.#scope, graphStore);
        try {
          result = await fn(memory);
        } catch (error) {
          threw = true;
          failure = error;
        }
        this.#persist(this.#scope, memory);
        this.#db.exec('COMMIT');
      } catch (error) {
        try { this.#db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw error;
      }
      if (threw) throw failure;
      return result;
    });
  }

  #unionAcrossScopes(fn, input) {
    return this.#serialize(() => this.#transaction(async () => {
      const graphStore = await this.#hydrateGraphStore();
      const rows = [];
      for (const { scope } of this.#statements.scopes.all()) {
        rows.push(...await fn(this.#hydrateUnitStore(scope, graphStore)));
      }
      rows.sort((left, right) => (left.recordedAt < right.recordedAt ? -1 : left.recordedAt > right.recordedAt ? 1 : 0));
      const limit = input && Number.isSafeInteger(input.limit) ? input.limit : undefined;
      return Object.freeze(limit === undefined ? rows : rows.slice(0, limit));
    }));
  }
}

module.exports = Object.freeze({ ALL_SCOPE, SqliteUnitStore, UNIT_STORE_METHODS });
