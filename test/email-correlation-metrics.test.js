'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { readCorrelationMetrics } = require('../lib/email-correlation/metrics');

test('correlation metrics derive rates, corrections, and latency from immutable journals', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE job_email_message_refs(id INTEGER PRIMARY KEY,received_at TEXT NOT NULL);
    CREATE TABLE job_email_correlations(
      id INTEGER PRIMARY KEY,message_ref_id INTEGER NOT NULL,resolution TEXT NOT NULL,
      resolved_application_id INTEGER,correlation_json TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE job_email_correlation_candidates(correlation_id INTEGER NOT NULL,application_id INTEGER NOT NULL);
    CREATE TABLE email_clarifications(message_ref_id INTEGER NOT NULL,candidate_application_ids_json TEXT NOT NULL);
    CREATE TABLE email_link_retractions(id INTEGER PRIMARY KEY,message_ref_id INTEGER NOT NULL,application_id INTEGER);
  `);
  const insertMessage = db.prepare('INSERT INTO job_email_message_refs(id,received_at) VALUES (?,?)');
  const insertCorrelation = db.prepare(`
    INSERT INTO job_email_correlations(
      id,message_ref_id,resolution,resolved_application_id,correlation_json,created_at
    ) VALUES (?,?,?,?,?,?)
  `);
  for (let id = 1; id <= 4; id += 1) insertMessage.run(id, `2026-09-02T00:0${id}:00.000Z`);

  insertCorrelation.run(1, 1, 'linked', 11, JSON.stringify({ evidence: [] }), '2026-09-02T00:01:30.000Z');
  insertCorrelation.run(2, 2, 'ambiguous', null, JSON.stringify({ evidence: [] }), '2026-09-02T00:02:30.000Z');
  insertCorrelation.run(3, 2, 'linked', 11, JSON.stringify({ evidence: [{ kind: 'operator_resolution', value: 'agent chose' }] }), '2026-09-02T00:05:00.000Z');
  insertCorrelation.run(4, 3, 'ambiguous', null, JSON.stringify({ evidence: [] }), '2026-09-02T00:04:00.000Z');
  insertCorrelation.run(5, 4, 'linked', 22, JSON.stringify({ evidence: [] }), '2026-09-02T00:05:00.000Z');
  db.prepare('INSERT INTO job_email_correlation_candidates(correlation_id,application_id) VALUES (?,?)').run(1, 11);
  db.prepare('INSERT INTO job_email_correlation_candidates(correlation_id,application_id) VALUES (?,?)').run(3, 11);
  db.prepare('INSERT INTO job_email_correlation_candidates(correlation_id,application_id) VALUES (?,?)').run(3, 22);
  db.prepare('INSERT INTO job_email_correlation_candidates(correlation_id,application_id) VALUES (?,?)').run(4, 11);
  db.prepare('INSERT INTO job_email_correlation_candidates(correlation_id,application_id) VALUES (?,?)').run(4, 22);
  db.prepare('INSERT INTO job_email_correlation_candidates(correlation_id,application_id) VALUES (?,?)').run(5, 22);
  db.prepare('INSERT INTO email_clarifications(message_ref_id,candidate_application_ids_json) VALUES (?,?)').run(3, '[11,22]');
  const application = readCorrelationMetrics(db, { applicationId: 11 });
  assert.deepEqual(application.counts, {
    correlatedMessages: 3,
    linkedMessages: 2,
    automaticLinks: 1,
    agentLinks: 1,
    clarifications: 1,
    mislinkRetractions: 0
  });
  assert.deepEqual(application.rates, {
    automaticLink: 1 / 3,
    agentLink: 1 / 3,
    clarify: 1 / 3
  });
  assert.deepEqual(application.timeToLink, {
    samples: 2,
    excludedSamples: 0,
    averageMs: 105_000,
    medianMs: 30_000,
    p95Ms: 180_000
  });

  const all = readCorrelationMetrics(db);
  assert.deepEqual(all.counts, {
    correlatedMessages: 4,
    linkedMessages: 3,
    automaticLinks: 2,
    agentLinks: 1,
    clarifications: 1,
    mislinkRetractions: 0
  });

  const insertRetraction = db.prepare('INSERT INTO email_link_retractions(id,message_ref_id,application_id) VALUES (?,?,?)');
  insertRetraction.run(1, 1, 11);
  insertRetraction.run(2, 1, 22);
  insertRetraction.run(3, 1, 11);
  const corrected = readCorrelationMetrics(db, { applicationId: 11 });
  assert.deepEqual(corrected.counts, {
    correlatedMessages: 3,
    linkedMessages: 1,
    automaticLinks: 0,
    agentLinks: 1,
    clarifications: 1,
    mislinkRetractions: 1
  });
  assert.equal(corrected.timeToLink.samples, 1);
  assert.equal(readCorrelationMetrics(db).counts.mislinkRetractions, 1,
    'one corrected message is one mislink even when it produced several pair events');
});

test('time-to-link clamps only sub-second SQLite timestamp truncation and excludes backward clocks', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE job_email_message_refs(id INTEGER PRIMARY KEY,received_at TEXT NOT NULL);
    CREATE TABLE job_email_correlations(
      id INTEGER PRIMARY KEY,message_ref_id INTEGER NOT NULL,resolution TEXT NOT NULL,
      resolved_application_id INTEGER,correlation_json TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE job_email_correlation_candidates(correlation_id INTEGER NOT NULL,application_id INTEGER NOT NULL);
    INSERT INTO job_email_message_refs(id,received_at) VALUES
      (1,'2026-09-02T00:00:00.900Z'),
      (2,'2026-09-02T00:00:02.000Z');
    INSERT INTO job_email_correlations(
      id,message_ref_id,resolution,resolved_application_id,correlation_json,created_at
    ) VALUES
      (1,1,'linked',11,'{"evidence":[]}','2026-09-02 00:00:00'),
      (2,2,'linked',11,'{"evidence":[]}','2026-09-02 00:00:00');
  `);

  const metrics = readCorrelationMetrics(db);
  assert.equal(metrics.counts.linkedMessages, 2);
  assert.deepEqual(metrics.timeToLink, {
    samples: 1,
    excludedSamples: 1,
    averageMs: 0,
    medianMs: 0,
    p95Ms: 0
  });
});

test('empty correlation metrics use null rates instead of claiming zero-percent evidence', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  assert.deepEqual(readCorrelationMetrics(db, { applicationId: 9 }).rates, {
    automaticLink: null,
    agentLink: null,
    clarify: null
  });
  assert.throws(() => readCorrelationMetrics(db, { applicationId: 0 }), /positive integer/);
});
