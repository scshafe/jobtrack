'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  resolveOrCreatePosting,
  resolveOrCreateSkill,
  resolveOrCreateVenue,
  resolvePlatform
} = require('../lib/catalog');

const {
  buildInterviewPrepContext,
  createInterviewPrepAnalysis,
  createScheduledInterview,
  generateDeterministicPrep,
  getCurrentInterviewPrep,
  isInterviewPrepAnalysisStale,
  listInterviewPrepQueue,
  reviewInterviewPrepAnalysis,
  selectCurrentInterviewPrep,
  updateScheduledInterview
} = require('../lib/interview-prep');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('canonical interview writer keeps schedule projections aligned and cancelled rounds leave the prep queue', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const first = createScheduledInterview(db, {
      applicationId,
      roundType: 'technical_screen',
      scheduledAt: '2026-07-25T17:00:00-07:00',
      timezone: 'America/Los_Angeles',
      format: 'video'
    });
    assert.equal(first.round, 'technical');
    assert.equal(first.scheduled_start_utc, '2026-07-26T00:00:00.000Z');
    assert.equal(first.scheduling_status, 'scheduled');
    assert.equal(first.sequence_no, 1);
    assert.equal(listInterviewPrepQueue(db).length, 1);

    const cancelled = updateScheduledInterview(db, first.id, {
      schedulingStatus: 'cancelled',
      expectedLockVersion: 0
    });
    assert.equal(cancelled.scheduling_status, 'cancelled');
    assert.equal(cancelled.lock_version, 1);
    assert.equal(listInterviewPrepQueue(db).length, 0);
  } finally {
    db.close();
  }
});

test('prep evidence is application/opening scoped and failed creation consumes no idempotency key', (t) => {
  const fixture = createStore(t);
  const alphaId = addApplication(fixture.home, 'Alpha', 'Frontend Engineer');
  const betaId = addApplication(fixture.home, 'Beta', 'FPGA Engineer');
  const db = fixture.open();
  try {
    const interview = createScheduledInterview(db, {
      applicationId: alphaId,
      roundType: 'technical_screen',
      scheduledAt: '2026-07-25T17:00:00Z',
      format: 'video'
    });
    const artifactId = Number(db.prepare(`
      INSERT INTO application_artifacts (application_id,kind,title,content)
      VALUES (?, 'research', 'Other application evidence', 'Beta-only evidence')
    `).run(betaId).lastInsertRowid);
    assert.throws(() => createInterviewPrepAnalysis(db, analysisInput(interview.id, {
      evidence: { snapshots: [], artifacts: [{ id: artifactId, reason: 'Wrong application' }], profiles: [] }
    }), { idempotencyKey: 'prep:wrong-artifact' }), (error) => error.code === 'EVIDENCE_MISMATCH');
    assert.equal(db.prepare("SELECT count(*) AS count FROM interview_prep_operations WHERE idempotency_key='prep:wrong-artifact'").get().count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM interview_prep_analyses').get().count, 0);

    const categoryId = db.prepare("SELECT id FROM skill_categories WHERE slug='languages'").get().id;
    const cobol = resolveOrCreateSkill(db, 'COBOL', categoryId);
    assert.throws(() => createInterviewPrepAnalysis(db, analysisInput(interview.id, {
      skillFocus: [{
        skillId: cobol.id,
        requirementKind: 'required',
        focusKind: 'gap',
        priority: 5,
        notes: 'Ungrounded requirement',
        evidenceSnapshotId: null
      }]
    }), { idempotencyKey: 'prep:ungrounded-skill' }), (error) => error.code === 'SKILL_FOCUS_MISMATCH');
    assert.equal(db.prepare("SELECT count(*) AS count FROM interview_prep_operations WHERE idempotency_key='prep:ungrounded-skill'").get().count, 0);

    const opening = db.prepare('SELECT job_opening_id FROM applications WHERE id=?').get(alphaId);
    const platform = resolvePlatform(db, 'direct');
    const companyId = db.prepare('SELECT company_id FROM job_openings WHERE id=?').get(opening.job_opening_id).company_id;
    const venue = resolveOrCreateVenue(db, {
      platformId: platform.id,
      companyId,
      venueKey: 'alpha.example.test',
      label: 'Alpha careers'
    });
    const posting = resolveOrCreatePosting(db, {
      openingId: opening.job_opening_id,
      venueId: venue.id,
      url: 'https://alpha.example.test/jobs/frontend'
    });
    const requiredKindId = db.prepare("SELECT id FROM requirement_kinds WHERE slug='required'").get().id;
    db.prepare(`
      INSERT INTO posting_skill_requirements (
        job_posting_id, skill_id, requirement_kind_id, raw_phrase, source
      ) VALUES (?, ?, ?, 'COBOL required', 'test')
    `).run(posting.id, cobol.id, requiredKindId);
    const grounded = createInterviewPrepAnalysis(db, analysisInput(interview.id, {
      skillFocus: [{
        skillId: cobol.id,
        requirementKind: 'required',
        focusKind: 'gap',
        priority: 5,
        notes: 'Manual posting requirement',
        evidenceSnapshotId: null
      }]
    }), { idempotencyKey: 'prep:grounded-skill' });
    assert.equal(grounded.skillFocus[0].canonical_name, 'COBOL');
  } finally {
    db.close();
  }
});

test('analysis creation, review, and selection are immutable, idempotent, and optimistic', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Backend Engineer');
  seedInterviewStory(fixture.home);
  const db = fixture.open();
  try {
    const interview = createScheduledInterview(db, {
      applicationId,
      roundType: 'hiring_manager',
      scheduledAt: '2026-08-01T09:00:00-07:00',
      timezone: 'America/Los_Angeles',
      format: 'video'
    });
    const context = buildInterviewPrepContext(db, interview.id);
    assert.equal(context.allowedStories.length, 1);

    const first = createInterviewPrepAnalysis(db, analysisInput(interview.id, {
      storyLinks: [{ storyId: 1, revisionId: 1, relation: 'example', notes: 'Interview example' }]
    }), { idempotencyKey: 'prep:first' });
    assert.equal(first.analysis.is_current, true);
    assert.equal(first.analysis.review_status, 'unreviewed');
    assert.deepEqual(first.events.map((event) => event.event_kind), ['created', 'selected']);
    assert.equal(createInterviewPrepAnalysis(db, analysisInput(interview.id, {
      storyLinks: [{ storyId: 1, revisionId: 1, relation: 'example', notes: 'Interview example' }]
    }), { idempotencyKey: 'prep:first' }).analysis.id, first.analysis.id);

    reviewInterviewPrepAnalysis(db, {
      analysisId: first.analysis.id,
      decision: 'approved',
      reviewedBy: 'Cole'
    }, { idempotencyKey: 'prep:first:review' });

    const second = generateDeterministicPrep(db, interview.id, {
      generatedBy: 'deterministic-test',
      idempotencyKey: 'prep:second'
    });
    assert.notEqual(second.analysis.id, first.analysis.id);
    assert.equal(second.analysis.is_current, false);
    assert.equal(getCurrentInterviewPrep(db, interview.id).analysis.id, first.analysis.id);

    assert.throws(() => selectCurrentInterviewPrep(db, {
      analysisId: second.analysis.id,
      selectedBy: 'Cole',
      expectedCurrentAnalysisId: 'none'
    }, { idempotencyKey: 'prep:select:stale' }), (error) => error.code === 'STALE_CURRENT');
    assert.equal(db.prepare("SELECT count(*) AS count FROM interview_prep_operations WHERE idempotency_key='prep:select:stale'").get().count, 0);

    const selected = selectCurrentInterviewPrep(db, {
      analysisId: second.analysis.id,
      selectedBy: 'Cole',
      expectedCurrentAnalysisId: first.analysis.id
    }, { idempotencyKey: 'prep:select:second' });
    assert.equal(selected.prep.analysis.is_current, true);
    assert.equal(getCurrentInterviewPrep(db, interview.id).analysis.id, second.analysis.id);

    updateScheduledInterview(db, interview.id, {
      notes: 'Recruiter added a focus area',
      expectedLockVersion: 0
    });
    assert.equal(isInterviewPrepAnalysisStale(db, second.analysis.id), true);
  } finally {
    db.close();
  }
});

function analysisInput(interviewId, overrides = {}) {
  return {
    interviewId,
    status: 'draft',
    title: 'Evidence-bound interview preparation',
    executiveSummary: 'A concise evidence-backed preparation plan.',
    strategy: 'Practice relevant examples and verify every factual claim.',
    generatedBy: 'test-agent',
    generatorVersion: 'test.v1',
    sections: [{ kind: 'role_focus', heading: 'Role focus', content: 'Prepare for the role using only linked evidence.' }],
    questions: [],
    skillFocus: [],
    storyLinks: [],
    evidence: { snapshots: [], artifacts: [], profiles: [] },
    ...overrides
  };
}

function createStore(t) {
  const { root: rootDir, home } = require('../test-support/migrated-store').createTestStore('jobtrack-interview-prep-');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return {
    home,
    open() {
      const db = new Database(path.join(home, 'jobtrack.db'));
      db.pragma('foreign_keys = ON');
      return db;
    }
  };
}

function addApplication(home, company, role) {
  return runCli(home, ['add-application', '--company', company, '--role', role]).application.id;
}

function seedInterviewStory(home) {
  runCli(home, [
    'story', 'capture', '--title', 'Recovered a launch', '--raw', 'Preserved source narrative.',
    '--source', 'test', '--idempotency-key', 'story:prep:capture'
  ]);
  runCli(home, [
    'story', 'polish', '--story-id', '1', '--expected-version', '0',
    '--canonical', 'Made the failure visible, coordinated recovery, and improved the system.',
    '--summary', 'Recovered a difficult launch', '--takeaway', 'Calm ownership improves systems.',
    '--why-it-matters', 'Shows judgment and communication.', '--status', 'ready',
    '--authored-by', 'test-agent', '--idempotency-key', 'story:prep:polish'
  ]);
  runCli(home, [
    'story', 'permission', 'set', '--story-id', '1', '--expected-version', '1',
    '--purpose', 'interview', '--decision', 'allow', '--approved-by', 'Cole',
    '--idempotency-key', 'story:prep:permission'
  ]);
}

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8'
  }));
}
