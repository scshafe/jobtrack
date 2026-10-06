'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  OPPORTUNITY_PROVENANCE_SCHEMA_VERSION,
  OpportunityError,
  canonicalizeUrl,
  getOpportunity,
  listOpportunities,
  migrateOpportunities,
  runOpportunityCommand
} = require('../lib/opportunities');

function makeDb({ migrate = true } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','interviewing','offer','rejected','withdrawn')),
      workflow_stage TEXT NOT NULL DEFAULT 'submitted',
      applied_date TEXT,
      job_url TEXT,
      notes TEXT,
      status_changed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE application_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT,
      source_url TEXT,
      source_name TEXT,
      citation TEXT,
      notes TEXT,
      content TEXT,
      attachment_path TEXT,
      captured_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE application_lifecycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE profile_entries (id INTEGER PRIMARY KEY);
    INSERT INTO profile_entries (id) VALUES (2), (5);
  `);
  if (migrate) migrateOpportunities(db);
  return db;
}

function fixedClock() {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 6, 17, 12, tick++)).toISOString() };
}

function command(db, args, flags = {}, context = {}) {
  return runOpportunityCommand(db, args, flags, context);
}

function addAllowedSource(db, key = 'acme-greenhouse') {
  command(db, ['discovery', 'source', 'add'], {
    key,
    adapter: 'greenhouse',
    baseUrl: `https://boards-api.greenhouse.io/v1/boards/${key}/jobs`,
    policyState: 'allowed',
    config: { boardToken: key },
  });
  return key;
}

test('canonicalizeUrl conservatively removes tracking and rejects unsafe URLs', () => {
  assert.equal(
    canonicalizeUrl('HTTPS://Example.COM:443/jobs/42?utm_source=newsletter&gh_jid=42&ref=friend#apply'),
    'https://example.com/jobs/42?gh_jid=42&ref=friend',
  );
  assert.equal(
    canonicalizeUrl('https://example.com/jobs/42?fbclid=abc&jobId=7'),
    'https://example.com/jobs/42?jobId=7',
  );
  assert.throws(() => canonicalizeUrl('file:///etc/passwd'), (error) => error instanceof OpportunityError && error.code === 'INVALID_URL');
  assert.throws(() => canonicalizeUrl('https://user:secret@example.com/jobs/1'), /must not contain credentials/);
});

test('migration is idempotent and seeds only an allowed manual source', () => {
  const db = makeDb();
  migrateOpportunities(db);
  const source = db.prepare("SELECT * FROM discovery_sources WHERE source_key='manual'").get();
  assert.equal(source.adapter, 'manual');
  assert.equal(source.policy_state, 'allowed');
  assert.equal(db.prepare("SELECT count(*) AS count FROM discovery_sources WHERE source_key='manual'").get().count, 1);
  const appColumns = db.prepare('PRAGMA table_info(applications)').all().map((row) => row.name);
  const artifactColumns = db.prepare('PRAGMA table_info(application_artifacts)').all().map((row) => row.name);
  assert.ok(appColumns.includes('source_opportunity_id'));
  assert.ok(artifactColumns.includes('opportunity_snapshot_id'));
  db.close();
});

test('migration composes with the outer JobTrack migration transaction', () => {
  const db = makeDb({ migrate: false });
  db.transaction(() => migrateOpportunities(db)).immediate();
  assert.equal(db.prepare("SELECT name FROM jobtrack_schema_migrations WHERE version=2026071702").get().name, 'opportunity_discovery_inbox');
  assert.equal(db.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='opportunities'").get().count, 1);
  db.close();
});

test('1707 upgrades an already-recorded 1705 database with observation provenance and inverse closure guards', () => {
  const db = makeDb({ migrate: false });
  db.exec(`
    CREATE TABLE jobtrack_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO jobtrack_schema_migrations (version, name) VALUES
      (2026071702, 'opportunity_discovery_inbox'),
      (2026071705, 'opportunity_state_and_run_guards');

    CREATE TABLE opportunities (
      id INTEGER PRIMARY KEY,
      state TEXT NOT NULL,
      closed_at TEXT,
      closed_reason TEXT,
      close_confidence TEXT
    );
    CREATE TABLE opportunity_snapshots (
      id INTEGER PRIMARY KEY,
      opportunity_id INTEGER NOT NULL REFERENCES opportunities(id),
      parser_name TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      http_status INTEGER,
      content_type TEXT,
      etag TEXT,
      last_modified TEXT,
      raw_attachment_path TEXT,
      raw_sha256 TEXT
    );
    CREATE TABLE opportunity_observations (
      id INTEGER PRIMARY KEY,
      opportunity_id INTEGER NOT NULL REFERENCES opportunities(id),
      source_id INTEGER,
      run_id INTEGER,
      snapshot_id INTEGER REFERENCES opportunity_snapshots(id) ON DELETE SET NULL,
      ingestion_key TEXT NOT NULL UNIQUE,
      external_id TEXT,
      observed_url TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TRIGGER trg_opportunity_observations_immutable_update
    BEFORE UPDATE ON opportunity_observations
    BEGIN SELECT RAISE(ABORT, 'opportunity observations are immutable'); END;
    CREATE TRIGGER trg_opportunity_observations_immutable_delete
    BEFORE DELETE ON opportunity_observations
    BEGIN SELECT RAISE(ABORT, 'opportunity observations are immutable'); END;

    INSERT INTO opportunities (id, state) VALUES (1, 'inbox');
    INSERT INTO opportunity_snapshots (
      id, opportunity_id, parser_name, parser_version, http_status, content_type, etag, last_modified,
      raw_attachment_path, raw_sha256
    ) VALUES (
      10, 1, 'greenhouse', '2026.07', 200, 'application/json', 'etag-a', 'Thu, 16 Jul 2026 12:00:00 GMT',
      'attachments/raw-a.json', '${'a'.repeat(64)}'
    );
    INSERT INTO opportunity_observations (
      id, opportunity_id, snapshot_id, ingestion_key, observed_url, observed_at, payload_sha256
    ) VALUES (
      20, 1, 10, '${'b'.repeat(64)}', 'https://example.com/jobs/1', '2026-07-17T12:00:00.000Z', '${'c'.repeat(64)}'
    );
  `);

  migrateOpportunities(db);

  const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(OPPORTUNITY_PROVENANCE_SCHEMA_VERSION);
  assert.equal(migration.name, 'opportunity_observation_retrieval_provenance');
  const observation = db.prepare('SELECT * FROM opportunity_observations WHERE id=20').get();
  assert.equal(observation.parser_name, 'greenhouse');
  assert.equal(observation.parser_version, '2026.07');
  assert.equal(observation.http_status, 200);
  assert.equal(observation.content_type, 'application/json');
  assert.equal(observation.etag, 'etag-a');
  assert.equal(observation.last_modified, 'Thu, 16 Jul 2026 12:00:00 GMT');
  assert.equal(observation.raw_attachment_path, 'attachments/raw-a.json');
  assert.equal(observation.raw_sha256, 'a'.repeat(64));
  assert.throws(() => db.prepare('UPDATE opportunity_observations SET etag=? WHERE id=20').run('tampered'), /immutable/);
  assert.throws(
    () => db.prepare('UPDATE opportunities SET closed_at=? WHERE id=1').run('2026-07-17T13:00:00.000Z'),
    /closure provenance requires closed state/
  );
  db.close();
});

test('agent source/query CRUD rejects secrets and gates scan runs by policy', () => {
  const db = makeDb();
  assert.throws(() => command(db, ['discovery', 'source', 'add'], {
    key: 'unsafe', adapter: 'api', baseUrl: 'https://example.com/jobs', config: { apiKey: 'secret' },
  }), (error) => error.code === 'SECRET_REJECTED');

  const source = command(db, ['discovery', 'source', 'add'], {
    key: 'lever-demo', adapter: 'lever', baseUrl: 'https://api.lever.co/v0/postings/demo',
    config: { site: 'demo' }, policyState: 'unreviewed', attribution: 'Lever',
  }).source;
  assert.equal(source.enabled, true);
  assert.equal(source.config.site, 'demo');
  assert.throws(() => command(db, ['discovery', 'run', 'start'], { source: 'lever-demo' }), (error) => error.code === 'SOURCE_POLICY_DENIED');
  assert.throws(() => command(db, ['opportunity', 'ingest'], {
    source: 'lever-demo', url: 'https://jobs.example.com/not-reviewed', company: 'Example', role: 'Engineer'
  }), (error) => error.code === 'SOURCE_POLICY_DENIED');
  command(db, ['discovery', 'source', 'update'], { key: 'lever-demo', policyState: 'allowed' });

  const query = command(db, ['discovery', 'query', 'add'], {
    key: 'platform', name: 'Platform roles', criteria: { include: ['platform', 'infrastructure'], exclude: ['principal'] },
  }).query;
  assert.deepEqual(query.criteria.include, ['platform', 'infrastructure']);

  const context = fixedClock();
  const run = command(db, ['discovery', 'run', 'start'], { source: 'lever-demo', query: 'platform', cursor: 'page-1' }, context).run;
  assert.equal(run.status, 'running');
  assert.throws(() => command(db, ['discovery', 'run', 'start'], { source: 'lever-demo' }), (error) => error.code === 'RUN_CONFLICT');
  const finished = command(db, ['discovery', 'run', 'finish'], {
    runId: run.id, status: 'succeeded', requestCount: 1, seenCount: 3, newCount: 2, updatedCount: 1, etag: 'abc',
  }, context).run;
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.seen_count, 3);
  assert.equal(command(db, ['discovery', 'runs', 'list'], {}).runs.length, 1);
  assert.throws(
    () => command(db, ['discovery', 'run', 'start'], { source: 'lever-demo' }, context),
    (error) => error.code === 'SOURCE_RATE_LIMIT' && error.details.retryAfterSeconds > 0
  );

  command(db, ['discovery', 'source', 'add'], {
    key: 'failed-demo', adapter: 'lever', baseUrl: 'https://api.lever.co/v0/postings/failed-demo',
    policyState: 'allowed', minIntervalSeconds: 3600
  });
  const failedRun = command(db, ['discovery', 'run', 'start'], { source: 'failed-demo' }, context).run;
  command(db, ['discovery', 'run', 'finish'], {
    runId: failedRun.id, status: 'failed', requestCount: 1, seenCount: 0, newCount: 0,
    updatedCount: 0, closedCount: 0, errorCode: 'HTTP_ERROR', errorMessage: '503'
  }, context);
  assert.throws(
    () => command(db, ['discovery', 'run', 'start'], { source: 'failed-demo' }, context),
    (error) => error.code === 'SOURCE_RATE_LIMIT' && error.details.retryAfterSeconds > 0
  );
  db.close();
});

test('ingest is idempotent, preserves immutable snapshots, and resolves URL/provider aliases', () => {
  const db = makeDb();
  addAllowedSource(db);
  const context = fixedClock();
  const run = command(db, ['discovery', 'run', 'start'], { source: 'acme-greenhouse' }, context).run;
  const first = command(db, ['opportunity', 'ingest'], {
    source: 'acme-greenhouse', runId: run.id, externalId: 'job-42', board: 'acme',
    url: 'https://jobs.example.com/platform/42?utm_source=feed#apply',
    company: 'Acme', role: 'Platform Engineer', location: 'Remote', workplaceType: 'remote',
    description: 'Build reliable developer infrastructure.', payload: { revision: 1 },
  }, context);
  assert.equal(first.created, true);
  assert.equal(first.observationCreated, true);

  const repeated = command(db, ['opportunity', 'ingest'], {
    source: 'acme-greenhouse', runId: run.id, externalId: 'job-42', board: 'acme',
    url: 'https://jobs.example.com/platform/42?utm_campaign=again',
    company: 'Acme', role: 'Platform Engineer', location: 'Remote', workplaceType: 'remote',
    description: 'Build reliable developer infrastructure.', payload: { revision: 1 },
  }, context);
  assert.equal(repeated.opportunityId, first.opportunityId);
  assert.equal(repeated.observationCreated, false);
  assert.equal(db.prepare('SELECT count(*) count FROM opportunities').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) count FROM opportunity_snapshots').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) count FROM opportunity_observations').get().count, 1);

  const changedUrl = command(db, ['opportunity', 'ingest'], {
    source: 'acme-greenhouse', runId: run.id, externalId: 'job-42', board: 'acme',
    url: 'https://boards.example.com/acme/jobs/42', company: 'Acme', role: 'Platform Engineer',
    location: 'Remote', description: 'Build reliable developer infrastructure and deployment tooling.', payload: { revision: 2 },
  }, context);
  assert.equal(changedUrl.opportunityId, first.opportunityId);
  assert.equal(db.prepare('SELECT count(*) count FROM opportunity_snapshots').get().count, 2);
  assert.equal(db.prepare('SELECT count(*) count FROM opportunity_observations').get().count, 2);
  assert.throws(() => db.prepare('UPDATE opportunity_snapshots SET normalized_text=? WHERE id=?').run('tampered', changedUrl.snapshotId), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM opportunity_observations WHERE opportunity_id=?').run(first.opportunityId), /immutable/);

  const oldAlias = command(db, ['opportunity', 'ingest'], {
    source: 'manual', url: 'https://jobs.example.com/platform/42', company: 'Acme', role: 'Platform Engineer',
    description: 'Build reliable developer infrastructure.',
  }, context);
  assert.equal(oldAlias.opportunityId, first.opportunityId);
  assert.ok(getOpportunity(db, first.opportunityId).identities.length >= 3);
  db.close();
});

test('identical normalized content keeps source-specific retrieval provenance on each observation', () => {
  const db = makeDb();
  addAllowedSource(db, 'source-a');
  addAllowedSource(db, 'source-b');
  const shared = {
    url: 'https://jobs.example.com/platform/shared',
    company: 'Acme',
    role: 'Platform Engineer',
    location: 'San Francisco, CA',
    description: 'Build reliable developer infrastructure.',
    payload: { revision: 1 }
  };
  const first = command(db, ['opportunity', 'ingest'], {
    ...shared,
    source: 'source-a',
    parserName: 'greenhouse-source-a',
    parserVersion: '1.2.3',
    httpStatus: 200,
    contentType: 'application/json; charset=utf-8',
    etag: 'etag-source-a',
    lastModified: 'Thu, 16 Jul 2026 12:00:00 GMT',
    rawAttachmentPath: 'attachments/source-a.json',
    rawSha256: 'a'.repeat(64)
  });
  const second = command(db, ['opportunity', 'ingest'], {
    ...shared,
    source: 'source-b',
    parserName: 'greenhouse-source-b',
    parserVersion: '9.8.7',
    httpStatus: 206,
    contentType: 'application/vnd.api+json',
    etag: 'etag-source-b',
    lastModified: 'Fri, 17 Jul 2026 12:00:00 GMT',
    rawAttachmentPath: 'attachments/source-b.json',
    rawSha256: 'b'.repeat(64)
  });

  assert.equal(second.opportunityId, first.opportunityId);
  assert.equal(second.snapshotId, first.snapshotId);
  const shown = getOpportunity(db, first.opportunityId);
  assert.equal(shown.snapshots.length, 1);
  assert.equal(shown.snapshots[0].parser_name, 'greenhouse-source-a');
  assert.equal(shown.observations.length, 2);
  const sourceB = shown.observations.find((row) => row.source_key === 'source-b');
  assert.equal(sourceB.parser_name, 'greenhouse-source-b');
  assert.equal(sourceB.parser_version, '9.8.7');
  assert.equal(sourceB.http_status, 206);
  assert.equal(sourceB.content_type, 'application/vnd.api+json');
  assert.equal(sourceB.etag, 'etag-source-b');
  assert.equal(sourceB.last_modified, 'Fri, 17 Jul 2026 12:00:00 GMT');
  assert.equal(sourceB.raw_attachment_path, 'attachments/source-b.json');
  assert.equal(sourceB.raw_sha256, 'b'.repeat(64));
  db.close();
});

test('provider/URL identity conflicts fail closed rather than silently merging', () => {
  const db = makeDb();
  addAllowedSource(db);
  const one = command(db, ['opportunity', 'ingest'], {
    source: 'acme-greenhouse', externalId: 'one', url: 'https://example.com/jobs/one', company: 'A', role: 'Engineer',
  });
  const two = command(db, ['opportunity', 'ingest'], {
    source: 'acme-greenhouse', externalId: 'two', url: 'https://example.com/jobs/two', company: 'B', role: 'Engineer',
  });
  assert.notEqual(one.opportunityId, two.opportunityId);
  assert.throws(() => command(db, ['opportunity', 'ingest'], {
    source: 'acme-greenhouse', externalId: 'two', url: 'https://example.com/jobs/one', company: 'B', role: 'Engineer',
  }), (error) => error.code === 'IDENTITY_CONFLICT' && error.details.canonicalOpportunityId === one.opportunityId);
  assert.throws(() => command(db, ['opportunity', 'ingest'], {
    source: 'acme-greenhouse', provider: 'ashby', externalId: 'wrong-provider',
    url: 'https://example.com/jobs/provider-mismatch', company: 'C', role: 'Engineer'
  }), (error) => error.code === 'PROVENANCE_CONFLICT');
  db.close();
});

test('search, tags, and append-only triage preserve evidence and state history', () => {
  const db = makeDb();
  const context = fixedClock();
  const ingested = command(db, ['opportunity', 'add'], {
    source: 'manual', url: 'https://example.com/jobs/agent', company: 'Example', role: 'Agent Tools Engineer',
    location: 'Hybrid', description: 'Build agent-operable TypeScript tooling.',
  }, context);
  command(db, ['opportunity', 'tag'], { id: ingested.opportunityId, tags: 'agent,developer-tools' }, context);
  const first = command(db, ['opportunity', 'triage'], {
    id: ingested.opportunityId, decision: 'shortlist', score: 87, scoreCoverage: 0.8,
    dimensions: { role: 95, skills: 85 }, rationale: 'Strong tooling fit.', profileEntryRefs: '2,5',
  }, context);
  assert.equal(first.opportunity.state, 'shortlisted');
  assert.equal(first.triage.evidence_snapshot_id, ingested.snapshotId);
  command(db, ['opportunity', 'triage'], {
    id: ingested.opportunityId, decision: 'note', rationale: 'Verify location details.',
  }, context);
  const shown = command(db, ['opportunity', 'show'], { id: ingested.opportunityId }).opportunity;
  assert.equal(shown.triage.length, 2);
  assert.throws(() => db.prepare('UPDATE opportunity_triage SET rationale=? WHERE id=?').run('tampered', shown.triage[0].id), /append-only/);
  assert.equal(shown.triage[1].score, 87);
  assert.deepEqual(shown.triage[1].profileEntryRefs, [2, 5]);
  const listed = listOpportunities(db, { tag: 'agent', minScore: 80 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].latest_decision, 'note');
  assert.equal(listed[0].latest_rationale, 'Verify location details.');
  assert.equal(listed[0].score, 87);
  assert.deepEqual(listed[0].tags, ['agent', 'developer-tools']);
  assert.equal(Object.hasOwn(listed[0], 'tags_json'), false);
  assert.equal(listOpportunities(db, { text: 'TypeScript' }).length, 1);
  assert.throws(() => command(db, ['opportunity', 'triage'], {
    id: ingested.opportunityId, decision: 'note', score: 88, rationale: 'Missing coverage.'
  }), (error) => error.code === 'VALIDATION_ERROR');
  assert.throws(() => command(db, ['opportunity', 'triage'], {
    id: ingested.opportunityId, decision: 'note', score: 88, scoreCoverage: 1,
    rationale: 'Dangling profile reference.', profileEntryRefs: '999999'
  }), (error) => error.code === 'PROVENANCE_CONFLICT');
  db.close();
});

test('ingest and close workflows enforce source kill switches and terminal transitions', () => {
  const db = makeDb();
  addAllowedSource(db);
  command(db, ['discovery', 'source', 'disable'], { key: 'acme-greenhouse' });
  assert.throws(() => command(db, ['opportunity', 'ingest'], {
    source: 'acme-greenhouse', url: 'https://example.com/jobs/disabled', company: 'Acme', role: 'Engineer'
  }), (error) => error.code === 'SOURCE_DISABLED');

  const created = command(db, ['opportunity', 'add'], {
    source: 'manual', url: 'https://example.com/jobs/state', company: 'Acme', role: 'Engineer'
  });
  assert.throws(() => command(db, ['opportunity', 'add'], {
    source: 'manual', state: 'promoted', url: 'https://example.com/jobs/bypass', company: 'Acme', role: 'Engineer'
  }), (error) => error.code === 'STATE_CONFLICT');
  assert.throws(() => command(db, ['opportunity', 'reopen'], { id: created.opportunityId }), (error) => error.code === 'STATE_CONFLICT');
  const closed = command(db, ['opportunity', 'close'], { id: created.opportunityId, reason: 'Posting removed' }).opportunity;
  assert.equal(closed.state, 'closed');
  assert.throws(() => command(db, ['opportunity', 'close'], { id: created.opportunityId, reason: 'Again' }), (error) => error.code === 'STATE_CONFLICT');
  assert.throws(() => command(db, ['opportunity', 'triage'], {
    id: created.opportunityId, decision: 'shortlist', rationale: 'Must reopen before changing active state.'
  }), (error) => error.code === 'STATE_CONFLICT');
  const closedNote = command(db, ['opportunity', 'triage'], {
    id: created.opportunityId, decision: 'note', rationale: 'Closure confirmed against the public board.'
  });
  assert.equal(closedNote.opportunity.state, 'closed');
  const reopened = command(db, ['opportunity', 'reopen'], { id: created.opportunityId }).opportunity;
  assert.equal(reopened.state, 'inbox');
  db.close();
});

test('ingestion revalidates durable run state and source linkage', () => {
  const db = makeDb();
  addAllowedSource(db);
  const context = fixedClock();
  const run = command(db, ['discovery', 'run', 'start'], { source: 'acme-greenhouse' }, context).run;
  command(db, ['discovery', 'run', 'finish'], {
    runId: run.id, status: 'failed', requestCount: 0, seenCount: 0, newCount: 0,
    updatedCount: 0, closedCount: 0, errorCode: 'TEST_ABORT', errorMessage: 'test'
  }, context);
  assert.throws(() => command(db, ['opportunity', 'ingest'], {
    source: 'acme-greenhouse', runId: run.id, externalId: 'stale-run',
    url: 'https://example.com/jobs/stale-run', company: 'Acme', role: 'Engineer'
  }), (error) => error.code === 'RUN_CONFLICT');
  assert.equal(db.prepare('SELECT count(*) AS n FROM opportunities').get().n, 0);
  db.close();
});

test('promotion is atomic and idempotent with immutable posting provenance', () => {
  const db = makeDb();
  const context = fixedClock();
  const ingested = command(db, ['opportunity', 'add'], {
    source: 'manual', url: 'https://example.com/jobs/7', company: 'ExampleCo', role: 'Software Engineer',
    description: 'Build reliable systems.', attachmentPath: 'attachments/posting-7.html',
    rawSha256: 'a'.repeat(64),
  }, context);
  const promoted = command(db, ['opportunity', 'promote'], { id: ingested.opportunityId, notes: 'Cole will review fit.' }, context);
  assert.equal(promoted.created, true);
  assert.equal(promoted.application.status, 'applied');
  assert.equal(promoted.application.workflow_stage, 'prospective');
  assert.equal(promoted.application.applied_date, null);
  assert.match(promoted.application.notes, /not been submitted or applied to/i);
  assert.equal(promoted.application.source_opportunity_id, ingested.opportunityId);
  assert.equal(promoted.postingArtifact.opportunity_snapshot_id, ingested.snapshotId);
  assert.match(promoted.postingArtifact.citation, new RegExp(`snapshot #${ingested.snapshotId}`));
  const lifecycle = db.prepare('SELECT * FROM application_lifecycle_events WHERE application_id=?').all(promoted.application.id);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].event_kind, 'opportunity_promoted');
  assert.match(lifecycle[0].notes, /not been submitted or applied to/i);

  const repeated = command(db, ['opportunity', 'promote'], { id: ingested.opportunityId }, context);
  assert.equal(repeated.created, false);
  assert.equal(repeated.application.id, promoted.application.id);
  assert.equal(db.prepare('SELECT count(*) count FROM applications').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) count FROM application_artifacts').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) count FROM application_lifecycle_events').get().count, 1);
  assert.equal(db.prepare("SELECT count(*) count FROM opportunity_events WHERE event_kind='promoted'").get().count, 1);
  assert.throws(() => command(db, ['opportunity', 'triage'], {
    id: ingested.opportunityId, decision: 'dismiss', rationale: 'Must not detach promoted state.'
  }, context), (error) => error.code === 'STATE_CONFLICT');
  assert.throws(() => command(db, ['opportunity', 'reopen'], {
    id: ingested.opportunityId, reason: 'Must not reopen.'
  }, context), (error) => error.code === 'STATE_CONFLICT');
  db.close();
});

test('ingestion rejects idempotency collisions and does not let old observations replace current data', () => {
  const db = makeDb();
  addAllowedSource(db);
  const first = command(db, ['opportunity', 'ingest'], {
    source: 'acme-greenhouse', externalId: 'stable-id', board: 'acme',
    url: 'https://example.com/jobs/stable', company: 'Acme', role: 'Current Role',
    description: 'CURRENT DESCRIPTION', observedAt: '2026-07-17T12:00:00Z',
    idempotencyKey: 'stable-request'
  });
  const replay = command(db, ['opportunity', 'ingest'], {
    source: 'acme-greenhouse', externalId: 'stable-id', board: 'acme',
    url: 'https://example.com/jobs/stable', company: 'Acme', role: 'Current Role',
    description: 'CURRENT DESCRIPTION', observedAt: '2026-07-18T12:00:00Z',
    idempotencyKey: 'stable-request'
  });
  assert.equal(replay.replayed, true);
  assert.equal(db.prepare('SELECT count(*) n FROM opportunity_observations').get().n, 1);
  assert.throws(() => command(db, ['opportunity', 'ingest'], {
    source: 'acme-greenhouse', externalId: 'different-id', board: 'acme',
    url: 'https://example.com/jobs/different', company: 'Other', role: 'Other Role',
    description: 'DIFFERENT', idempotencyKey: 'stable-request'
  }), (error) => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(db.prepare('SELECT count(*) n FROM opportunities').get().n, 1);

  const old = command(db, ['opportunity', 'ingest'], {
    source: 'acme-greenhouse', externalId: 'stable-id', board: 'acme',
    url: 'https://example.com/jobs/stable', company: 'Acme', role: 'Old Role',
    description: 'OLD DESCRIPTION', observedAt: '2025-01-01T00:00:00Z',
    idempotencyKey: 'old-observation'
  });
  assert.equal(old.projectionAdvanced, false);
  const current = db.prepare('SELECT * FROM opportunities WHERE id=?').get(first.opportunityId);
  assert.equal(current.title, 'Current Role');
  assert.equal(current.description_text, 'CURRENT DESCRIPTION');
  assert.equal(current.last_verified_at, '2026-07-17T12:00:00.000Z');
  assert.equal(current.latest_snapshot_id, first.snapshotId);
  assert.equal(db.prepare('SELECT count(*) n FROM opportunity_observations').get().n, 2);
  db.close();
});
