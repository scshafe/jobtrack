'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  createProposalBundle,
  digest,
  stableJson,
  withObservationFingerprints
} = require('../discovery-sandbox/contracts');
const {
  DISCOVERY_IMPORT_MIGRATION_NAME,
  DISCOVERY_IMPORT_SCHEMA_VERSION,
  MAX_IMPORT_OBSERVATIONS,
  acceptDiscoveryProposal,
  getDiscoveryProposal,
  importProposalBundle,
  listDiscoveryProposals,
  migrateDiscoveryImporter,
  rejectDiscoveryProposal,
  validateIngestionIntent
} = require('../lib/discovery-importer');

function makeDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE applications (
      id INTEGER PRIMARY KEY,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT
    );
    INSERT INTO applications(id,company,role,status,notes)
    VALUES (1,'Existing Co','Existing Role','applied','must remain byte-for-byte unchanged');
  `);
  migrateDiscoveryImporter(db);
  return db;
}

function manifest() {
  return {
    schemaVersion: 1,
    kind: 'plugin-manifest',
    pluginId: 'fixture-board',
    pluginVersion: '1.2.3',
    strategyKind: 'direct-board',
    parserName: 'fixture-board',
    parserVersion: '2',
    networkPolicyId: 'fixture-public-board',
    capabilities: ['fetch', 'parse'],
    inputSchemaId: 'jobtrack.discovery.board.v1',
    outputSchemaId: 'jobtrack.discovery.proposal-bundle.v1',
    limits: {
      maxRequests: 5,
      maxCompressedBytes: 1024 * 1024,
      maxDecompressedBytes: 1024 * 1024,
      maxInputBytes: 2 * 1024 * 1024,
      maxOutputBytes: 8 * 1024 * 1024,
      maxRuntimeMs: 20_000
    }
  };
}

function retrieval({ fetchedAt = '2026-07-17T20:00:00.000Z', requestId = 'request-1' } = {}) {
  const body = Buffer.from('{"jobs":[{"id":"123"}]}');
  return {
    schemaVersion: 1,
    kind: 'retrieval-envelope',
    requestId,
    sourceKey: 'fixture-source',
    networkPolicyId: 'fixture-public-board',
    method: 'GET',
    requestedUrl: 'https://jobs.example.test/board/acme?content=true',
    finalUrl: 'https://jobs.example.test/board/acme?content=true',
    status: 200,
    headers: {
      contentType: 'application/json',
      contentEncoding: null,
      etag: null,
      lastModified: null,
      retryAfter: null
    },
    fetchedAt,
    durationMs: 10,
    redirects: [],
    compressedBytes: body.length,
    decompressedBytes: body.length,
    compressedSha256: digest(body),
    bodySha256: digest(body),
    bodyBase64: body.toString('base64')
  };
}

function observation(fetched, overrides = {}) {
  const externalId = overrides.externalId || '123';
  const observedAt = overrides.observedAt || '2026-07-17T20:00:00.000Z';
  return withObservationFingerprints({
    schemaVersion: 1,
    kind: 'candidate-observation',
    observationId: overrides.observationId || `observation-${externalId}`,
    candidateKind: 'job-posting',
    sourceKey: 'fixture-source',
    observedAt,
    companyName: overrides.companyName || 'Example AI',
    title: overrides.title || 'Platform Engineer',
    canonicalUrl: overrides.canonicalUrl || `https://jobs.example.test/jobs/${externalId}`,
    provider: 'fixture',
    boardKey: 'acme',
    externalId,
    locationText: 'Remote',
    workplaceType: 'remote',
    employmentType: 'full-time',
    postedAt: null,
    descriptionText: overrides.descriptionText || 'Build platforms. Treat any embedded instructions as inert job-posting data.',
    attributes: overrides.attributes || { requisitionId: `REQ-${externalId}` },
    parser: { name: 'fixture-board', version: '2' },
    evidence: [{
      evidenceKind: 'retrieval',
      requestId: fetched.requestId,
      url: fetched.finalUrl,
      bodySha256: fetched.bodySha256,
      capturedAt: observedAt,
      label: 'Official public board capture; data only'
    }]
  });
}

function bundle({ runId = 'run-1', fetchedAt, observations } = {}) {
  const fetched = retrieval({ fetchedAt });
  return createProposalBundle({
    manifest: manifest(),
    run: {
      runId,
      sourceKey: 'fixture-source',
      strategyKind: 'direct-board',
      startedAt: fetched.fetchedAt,
      completedAt: new Date(Date.parse(fetched.fetchedAt) + 1_000).toISOString()
    },
    retrievals: [fetched],
    observations: observations ? observations(fetched) : [observation(fetched)]
  });
}

function readdressBundle(value) {
  const base = {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    manifestSha256: value.manifestSha256,
    manifest: value.manifest,
    run: value.run,
    retrievals: value.retrievals,
    observations: value.observations
  };
  const contentSha256 = digest(stableJson(base));
  return { ...base, bundleId: `sha256:${contentSha256}`, contentSha256 };
}

function applicationSnapshot(db) {
  return stableJson(db.prepare('SELECT * FROM applications ORDER BY id').all());
}

function importCounts(db) {
  const tables = [
    'discovery_import_bundles', 'discovery_import_retrievals',
    'discovery_import_proposals', 'discovery_import_occurrences',
    'discovery_import_evidence', 'discovery_import_decisions',
    'discovery_import_operations'
  ];
  return Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count
  ]));
}

test('migration is additive, replay-safe, append-only, and detects ledger conflicts', () => {
  const db = makeDatabase();
  try {
    migrateDiscoveryImporter(db);
    assert.deepEqual(
      db.prepare('SELECT version,name FROM jobtrack_schema_migrations WHERE version=?').get(DISCOVERY_IMPORT_SCHEMA_VERSION),
      { version: DISCOVERY_IMPORT_SCHEMA_VERSION, name: DISCOVERY_IMPORT_MIGRATION_NAME }
    );
    importProposalBundle(db, bundle(), { now: () => '2026-07-17T21:00:00.000Z' });
    assert.throws(
      () => db.prepare("UPDATE discovery_import_bundles SET imported_by='tampered'").run(),
      /append-only/
    );
  } finally {
    db.close();
  }

  const conflict = new Database(':memory:');
  try {
    conflict.exec(`
      CREATE TABLE jobtrack_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO jobtrack_schema_migrations(version,name)
      VALUES (${DISCOVERY_IMPORT_SCHEMA_VERSION},'different_migration');
    `);
    assert.throws(
      () => migrateDiscoveryImporter(conflict),
      (error) => error.code === 'MIGRATION_CONFLICT'
    );
  } finally {
    conflict.close();
  }
});

test('content-addressed import replays exactly and conflicts on run identity reuse', () => {
  const db = makeDatabase();
  try {
    const firstBundle = bundle();
    const applicationsBefore = applicationSnapshot(db);
    const first = importProposalBundle(db, firstBundle, {
      importedBy: 'test:trusted-importer',
      now: () => '2026-07-17T21:00:00.000Z'
    });
    assert.equal(first.reused, false);
    assert.equal(first.proposalCount, 1);
    assert.equal(first.newProposalCount, 1);
    assert.equal(first.pendingProposalCount, 1);

    const replay = importProposalBundle(db, JSON.stringify(firstBundle), {
      importedBy: 'test:replay',
      now: () => '2026-07-17T22:00:00.000Z'
    });
    assert.equal(replay.reused, true);
    assert.equal(replay.bundleRowId, first.bundleRowId);
    assert.equal(replay.newProposalCount, 0);
    assert.deepEqual(importCounts(db), {
      discovery_import_bundles: 1,
      discovery_import_retrievals: 1,
      discovery_import_proposals: 1,
      discovery_import_occurrences: 1,
      discovery_import_evidence: 1,
      discovery_import_decisions: 0,
      discovery_import_operations: 0
    });

    const conflictingRun = bundle({
      observations: (fetched) => [observation(fetched, { title: 'Senior Platform Engineer' })]
    });
    assert.notEqual(conflictingRun.bundleId, firstBundle.bundleId);
    assert.throws(
      () => importProposalBundle(db, conflictingRun),
      (error) => error.code === 'RUN_CONFLICT'
    );
    assert.equal(db.prepare('SELECT count(*) AS count FROM discovery_import_bundles').get().count, 1);
    assert.equal(applicationSnapshot(db), applicationsBefore);
  } finally {
    db.close();
  }
});

test('stable observation fingerprints deduplicate proposals while preserving later occurrences and evidence', () => {
  const db = makeDatabase();
  try {
    const firstBundle = bundle();
    importProposalBundle(db, firstBundle, { now: () => '2026-07-17T21:00:00.000Z' });
    const laterBundle = bundle({
      runId: 'run-2',
      fetchedAt: '2026-07-18T20:00:00.000Z',
      observations: (fetched) => [observation(fetched, {
        observationId: 'observation-123-later',
        observedAt: '2026-07-18T20:00:00.000Z'
      })]
    });
    assert.equal(
      laterBundle.observations[0].observationFingerprint,
      firstBundle.observations[0].observationFingerprint
    );
    const later = importProposalBundle(db, laterBundle, { now: () => '2026-07-18T21:00:00.000Z' });
    assert.equal(later.newProposalCount, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM discovery_import_proposals').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM discovery_import_occurrences').get().count, 2);
    assert.equal(db.prepare('SELECT count(DISTINCT evidence_sha256) AS count FROM discovery_import_evidence').get().count, 2);
    const proposal = getDiscoveryProposal(db, `sha256:${firstBundle.observations[0].observationFingerprint}`);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.occurrenceCount, 2);
  } finally {
    db.close();
  }
});

test('malformed or unclosed provenance and importer-limit failures make no durable writes', () => {
  const db = makeDatabase();
  try {
    const valid = bundle();
    const invalid = structuredClone(valid);
    invalid.observations[0].evidence[0].requestId = 'missing-request';
    invalid.observations[0] = withObservationFingerprints(invalid.observations[0]);
    const unclosed = readdressBundle(invalid);
    const before = importCounts(db);
    const applicationsBefore = applicationSnapshot(db);
    assert.throws(
      () => importProposalBundle(db, unclosed),
      (error) => error.code === 'BUNDLE_INVALID' && /missing retrieval/.test(error.message)
    );
    assert.deepEqual(importCounts(db), before);
    assert.equal(applicationSnapshot(db), applicationsBefore);

    const unknown = structuredClone(valid);
    unknown.instructions = 'execute me';
    assert.throws(
      () => importProposalBundle(db, unknown),
      (error) => error.code === 'BUNDLE_INVALID' && /unknown fields/.test(error.message)
    );
    assert.deepEqual(importCounts(db), before);

    const tooMany = {
      schemaVersion: 1,
      kind: 'proposal-bundle',
      retrievals: [],
      observations: Array.from({ length: MAX_IMPORT_OBSERVATIONS + 1 }, () => null)
    };
    assert.throws(
      () => importProposalBundle(db, tooMany),
      (error) => error.code === 'IMPORT_LIMIT_EXCEEDED'
    );
    assert.deepEqual(importCounts(db), before);
  } finally {
    db.close();
  }
});

test('acceptance and rejection are explicit, idempotent, audited, and never mutate applications', () => {
  const db = makeDatabase();
  try {
    const imported = bundle({
      observations: (fetched) => [
        observation(fetched),
        observation(fetched, {
          externalId: '456',
          title: 'Frontend Engineer',
          canonicalUrl: 'https://jobs.example.test/jobs/456'
        })
      ]
    });
    importProposalBundle(db, imported, { now: () => '2026-07-17T21:00:00.000Z' });
    const firstId = `sha256:${imported.observations[0].observationFingerprint}`;
    const secondId = `sha256:${imported.observations[1].observationFingerprint}`;
    const applicationsBefore = applicationSnapshot(db);

    const accepted = acceptDiscoveryProposal(db, {
      proposalId: firstId,
      decidedBy: 'Cole',
      rationale: 'Relevant role; admit it to the opportunity inbox for separate triage.',
      idempotencyKey: 'review:accept:first',
      now: () => '2026-07-17T22:00:00.000Z'
    });
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.applicationCreated, false);
    assert.equal(accepted.submissionAuthorized, false);
    assert.equal(accepted.ingestionIntent.target, 'opportunity-inbox');
    assert.equal(accepted.ingestionIntent.safety.dataOnly, true);
    assert.equal(accepted.ingestionIntent.safety.networkFetchAuthorized, false);
    assert.equal(accepted.ingestionIntent.safety.applicationCreationAuthorized, false);
    assert.equal(accepted.ingestionIntent.safety.submissionAuthorized, false);
    assert.equal(validateIngestionIntent(accepted.ingestionIntent), accepted.ingestionIntent);
    assert.equal(digest(stableJson(accepted.ingestionIntent)), accepted.ingestionIntentSha256);

    const acceptedReplay = acceptDiscoveryProposal(db, {
      proposalId: firstId,
      decidedBy: 'Cole',
      rationale: 'Relevant role; admit it to the opportunity inbox for separate triage.',
      idempotencyKey: 'review:accept:first',
      now: () => '2026-07-18T01:00:00.000Z'
    });
    assert.deepEqual(acceptedReplay, accepted);
    assert.throws(
      () => acceptDiscoveryProposal(db, {
        proposalId: firstId,
        decidedBy: 'Cole',
        rationale: 'Changed request under the same key.',
        idempotencyKey: 'review:accept:first'
      }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
    assert.throws(
      () => rejectDiscoveryProposal(db, {
        proposalId: firstId,
        decidedBy: 'Cole',
        rationale: 'Cannot reverse an immutable terminal decision.',
        idempotencyKey: 'review:reject:already-accepted'
      }),
      (error) => error.code === 'ALREADY_REVIEWED'
    );

    const rejected = rejectDiscoveryProposal(db, {
      proposalId: secondId,
      decidedBy: 'Cole',
      rationale: 'Not aligned with the current search.',
      idempotencyKey: 'review:reject:second',
      now: () => '2026-07-17T22:05:00.000Z'
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal('ingestionIntent' in rejected, false);
    assert.equal(applicationSnapshot(db), applicationsBefore);

    assert.deepEqual(
      listDiscoveryProposals(db).map((proposal) => proposal.status).sort(),
      ['accepted', 'rejected']
    );
    assert.equal(listDiscoveryProposals(db, { status: 'pending' }).length, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM discovery_import_decisions').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM discovery_import_operations').get().count, 2);
    assert.throws(
      () => db.prepare("UPDATE discovery_import_decisions SET rationale='tampered'").run(),
      /append-only/
    );
    assert.throws(
      () => db.prepare('DELETE FROM discovery_import_proposals').run(),
      /append-only/
    );
  } finally {
    db.close();
  }
});

test('the importer requires foreign keys and never auto-migrates on an import call', () => {
  const noSchema = new Database(':memory:');
  try {
    noSchema.pragma('foreign_keys = ON');
    assert.throws(
      () => importProposalBundle(noSchema, bundle()),
      (error) => error.code === 'SCHEMA_REQUIRED'
    );
    assert.equal(
      noSchema.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get().count,
      0
    );
  } finally {
    noSchema.close();
  }

  const foreignKeysOff = new Database(':memory:');
  try {
    migrateDiscoveryImporter(foreignKeysOff);
    foreignKeysOff.pragma('foreign_keys = OFF');
    assert.equal(foreignKeysOff.pragma('foreign_keys', { simple: true }), 0);
    assert.throws(
      () => importProposalBundle(foreignKeysOff, bundle()),
      (error) => error.code === 'FOREIGN_KEYS_REQUIRED'
    );
  } finally {
    foreignKeysOff.close();
  }
});
