'use strict';

// The FABRIC read model (docs/FABRIC_PLAN.md, Phase A): a node registry over
// the pipeline, gate-behavior configuration lanes, and the pure derivation —
// "given everything the ledgers say, what is the next required act for each
// in-flight subject, and who is allowed to perform it?"
//
// Phase A is deliberately a READ MODEL: `deriveFabricNext` performs no acts
// and mutates nothing (beyond lazily creating the fabric's own config tables
// and the lanes' schema migrations, like every other command). Gates wrap the
// EXISTING lane verbs — their ledgers stay the source of truth; the fabric
// stores only how each gate should BEHAVE (human / policy / withhold — and,
// for the apply executor, agent / manual), as append-only configuration
// revisions mirroring strategy_routing_policy_revisions.
//
// Safety invariants (enforced here, not documented hope):
//   1. absent configuration = 'human' — a fresh store is fully parked;
//   2. OUTWARD-facing gates refuse mode='policy' unless the revision was set
//      with set_authorship='human' AND carries non-empty constraints — an
//      agent can never write itself permission to submit;
//   3. a policy decision cites the revision that made it (Phase B executes;
//      Phase A already surfaces revision ids in the resolution);
//   4. resolution is pure: same store + same config => same behavior.

const {
  acceptApplicationFormUncertainty,
  createMaterialRender,
  getApplicationReadiness,
  listApplicationMaterials,
  readPackageSubmissionFacts,
  recordApplicationSubmission,
  reviewMaterialRevision,
  selectMaterialRevision
} = require('./application-materials');
const { approveSubmission, proposeSubmission, readSubmissionState } = require('./application-submission');
const { latestRenderLintSummary, recordMaterialLintReport } = require('./resume-lint');
const { isCompactResumeTemplate } = require('./material-templates');
const { listInboundQueue, listOutstandingReplies, listStaleUnmatched, recorrelateFromStore, transmitReadiness } = require('./email-agent-lane');
const { listReplyIntents } = require('./email-reply-intents');
const {
  generateDeterministicPrep,
  isInterviewPrepAnalysisStale,
  reviewInterviewPrepAnalysis,
  selectCurrentInterviewPrep
} = require('./interview-prep');
const { assertUploadsVerified } = require('./upload-verification');
const { runOpportunityCommand } = require('./opportunities');

const FABRIC_SCHEMA_VERSION = 2026082002;
const FABRIC_NEXT_SCHEMA = 'jobtrack-fabric-next.v1';
const FABRIC_TICK_SCHEMA = 'jobtrack-fabric-tick.v1';

const GATE_MODES = Object.freeze(['human', 'policy', 'withhold']);
const EXECUTOR_MODES = Object.freeze(['agent', 'manual', 'withhold']);

class FabricError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FabricError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new FabricError(code, message);
}

/**
 * The node registry. `configurable: true` marks nodes whose behavior lives in
 * the gate-config lanes (every gate, plus the apply executor). Derivation
 * logic lives in deriveFabricNext, keyed by these ids — the registry is the
 * single place a node's identity, kind, and allowed behaviors are declared.
 */
const FABRIC_NODES = Object.freeze([
  { id: 'opportunity.triage', subjectKind: 'opportunity', kind: 'work', executor: 'agent', title: 'Triage the opportunity' },
  { id: 'opportunity.pursue', subjectKind: 'opportunity', kind: 'gate', configurable: true, allowedModes: GATE_MODES, defaultMode: 'human', title: 'Pursue / dismiss decision' },
  { id: 'application.intake', subjectKind: 'application', kind: 'work', executor: 'agent', title: 'Capture the posting into the store' },
  { id: 'application.research', subjectKind: 'application', kind: 'work', executor: 'agent', title: 'Company research' },
  { id: 'application.assess', subjectKind: 'application', kind: 'work', executor: 'agent', title: 'Assess role fit, risks, approach' },
  { id: 'application.assessment-review', subjectKind: 'application', kind: 'gate', configurable: true, allowedModes: GATE_MODES, defaultMode: 'human', title: 'Assessment review' },
  { id: 'application.form-recon', subjectKind: 'application', kind: 'work', executor: 'agent', title: 'Observe the application form' },
  { id: 'application.form-review', subjectKind: 'application', kind: 'gate', configurable: true, allowedModes: GATE_MODES, defaultMode: 'human', title: 'Form capture review' },
  { id: 'application.uncertainty-accept', subjectKind: 'application', kind: 'gate', configurable: true, allowedModes: GATE_MODES, defaultMode: 'human', title: 'Accept form-coverage uncertainty' },
  { id: 'application.materials.draft', subjectKind: 'application', kind: 'work', executor: 'agent', title: 'Draft material from the pool' },
  { id: 'application.materials.render-lint', subjectKind: 'application', kind: 'work', executor: 'deterministic', title: 'Render and lint' },
  { id: 'application.materials.review', subjectKind: 'application', kind: 'gate', configurable: true, allowedModes: GATE_MODES, defaultMode: 'human', title: 'Material review' },
  { id: 'application.materials.select', subjectKind: 'application', kind: 'gate', configurable: true, allowedModes: GATE_MODES, defaultMode: 'human', title: 'Material selection' },
  { id: 'application.package', subjectKind: 'application', kind: 'work', executor: 'deterministic', title: 'Build and bind the package' },
  { id: 'application.submission.propose', subjectKind: 'application', kind: 'work', executor: 'deterministic', title: 'Propose the submission intent' },
  { id: 'application.submission.approve', subjectKind: 'application', kind: 'gate', configurable: true, outward: true, allowedModes: GATE_MODES, defaultMode: 'human', title: 'Submission approval' },
  { id: 'application.apply', subjectKind: 'application', kind: 'work', executor: 'configurable', configurable: true, allowedModes: EXECUTOR_MODES, defaultMode: 'manual', title: 'Drive the submission on the surface' },
  { id: 'application.verify-record', subjectKind: 'application', kind: 'work', executor: 'deterministic', title: 'Verify uploads and record the submission' },
  { id: 'application.watch', subjectKind: 'application', kind: 'work', executor: 'deterministic', title: 'Watch the lifecycle' },
  { id: 'email.recorrelate', subjectKind: 'application', kind: 'work', executor: 'deterministic', title: 'Re-correlate an unattributed inbound email against the current record' },
  { id: 'email.review', subjectKind: 'application', kind: 'work', executor: 'agent', title: 'Read a linked inbound email and decide: reply, move the application, or nothing' },
  { id: 'email.reply', subjectKind: 'application', kind: 'work', executor: 'agent', title: 'Send the reply an inbound email still owes' },
  // The post-submitted lifecycle (FABRIC_PLAN A17, extended 2026-09-05): an
  // interview or an offer the email lane or a person recorded is an EVENT the
  // next tick notices; these nodes are what it then requires. Same shape as
  // the application half: deterministic work where code can do it, agent work
  // where judgment is needed, a human gate wherever authority is exercised.
  { id: 'interview.prep.generate', subjectKind: 'application', kind: 'work', executor: 'deterministic', title: 'Generate the first interview-prep draft' },
  { id: 'interview.prep.author', subjectKind: 'application', kind: 'work', executor: 'agent', title: 'Author an evidence-bound interview-prep analysis' },
  { id: 'interview.prep.review', subjectKind: 'application', kind: 'gate', configurable: true, allowedModes: GATE_MODES, defaultMode: 'human', title: 'Interview-prep review' },
  { id: 'interview.prep.select', subjectKind: 'application', kind: 'gate', configurable: true, allowedModes: GATE_MODES, defaultMode: 'human', title: 'Interview-prep selection' },
  { id: 'interview.upcoming', subjectKind: 'application', kind: 'work', executor: 'deterministic', title: 'Upcoming interview, prep ready' },
  { id: 'interview.outcome', subjectKind: 'application', kind: 'work', executor: 'manual', title: 'Record the interview outcome' },
  // An offer is decided by a person, always: the gate admits no policy mode.
  { id: 'offer.decision', subjectKind: 'application', kind: 'gate', configurable: true, allowedModes: Object.freeze(['human', 'withhold']), defaultMode: 'human', title: 'Offer decision' }
]);

const NODE_BY_ID = new Map(FABRIC_NODES.map((node) => [node.id, node]));

function fabricNode(gateId) {
  const node = NODE_BY_ID.get(gateId);
  if (!node) fail('UNKNOWN_GATE', `Unknown fabric node: ${gateId} (see \`jobtrack fabric gates\`)`);
  return node;
}

function configurableNode(gateId) {
  const node = fabricNode(gateId);
  if (!node.configurable) {
    fail('NOT_CONFIGURABLE', `Fabric node ${gateId} is a ${node.executor} ${node.kind}; only gates and the apply executor take configuration`);
  }
  return node;
}

// ---------------------------------------------------------------------------
// configuration lanes
// ---------------------------------------------------------------------------

function migrateFabric(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobtrack_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  if (db.prepare('SELECT 1 FROM jobtrack_schema_migrations WHERE version = ?').get(FABRIC_SCHEMA_VERSION)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS fabric_gate_policy_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gate_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('human','policy','withhold','agent','manual')),
      rules_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rules_json)),
      constraints_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(constraints_json)),
      notify_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(notify_json)),
      set_by TEXT NOT NULL CHECK (trim(set_by)<>''),
      set_authorship TEXT NOT NULL CHECK (set_authorship IN ('human','agent')),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fabric_gate_policy_gate ON fabric_gate_policy_revisions(gate_id, id DESC);
    CREATE TRIGGER IF NOT EXISTS trg_fabric_gate_policy_immutable_update
    BEFORE UPDATE ON fabric_gate_policy_revisions
    BEGIN SELECT RAISE(ABORT, 'fabric gate policy revisions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_fabric_gate_policy_immutable_delete
    BEFORE DELETE ON fabric_gate_policy_revisions
    BEGIN SELECT RAISE(ABORT, 'fabric gate policy revisions are append-only'); END;

    CREATE TABLE IF NOT EXISTS fabric_gate_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gate_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('opportunity','application')),
      subject_id INTEGER NOT NULL,
      mode TEXT CHECK (mode IS NULL OR mode IN ('human','policy','withhold','agent','manual')),
      reason TEXT NOT NULL CHECK (trim(reason)<>''),
      set_by TEXT NOT NULL CHECK (trim(set_by)<>''),
      set_authorship TEXT NOT NULL CHECK (set_authorship IN ('human','agent')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fabric_gate_overrides_subject ON fabric_gate_overrides(gate_id, subject_kind, subject_id, id DESC);
    CREATE TRIGGER IF NOT EXISTS trg_fabric_gate_override_immutable_update
    BEFORE UPDATE ON fabric_gate_overrides
    BEGIN SELECT RAISE(ABORT, 'fabric gate overrides are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_fabric_gate_override_immutable_delete
    BEFORE DELETE ON fabric_gate_overrides
    BEGIN SELECT RAISE(ABORT, 'fabric gate overrides are append-only'); END;
  `);
  db.prepare('INSERT INTO jobtrack_schema_migrations (version, name) VALUES (?, ?)')
    .run(FABRIC_SCHEMA_VERSION, 'fabric_gate_configuration');
}

function parseStored(row) {
  if (!row) return null;
  return {
    ...row,
    rules: JSON.parse(row.rules_json),
    constraints: JSON.parse(row.constraints_json),
    notify: JSON.parse(row.notify_json)
  };
}

function currentGatePolicy(db, gateId) {
  migrateFabric(db);
  return parseStored(db.prepare(
    'SELECT * FROM fabric_gate_policy_revisions WHERE gate_id=? ORDER BY id DESC LIMIT 1'
  ).get(gateId));
}

function currentGateOverride(db, gateId, subjectKind, subjectId) {
  migrateFabric(db);
  const row = db.prepare(`
    SELECT * FROM fabric_gate_overrides WHERE gate_id=? AND subject_kind=? AND subject_id=?
    ORDER BY id DESC LIMIT 1
  `).get(gateId, subjectKind, subjectId);
  if (!row || row.mode === null) return null; // a NULL mode row clears the override
  return row;
}

function nonEmptyObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

/**
 * Invariant 2, shared by set and override: automated behavior on an
 * outward-facing gate exists only when a HUMAN configured it, with bounds.
 */
function assertOutwardPolicyAllowed(node, mode, setAuthorship, constraints, what) {
  if (!node.outward || mode !== 'policy') return;
  if (setAuthorship !== 'human') {
    fail('OUTWARD_POLICY_REQUIRES_HUMAN',
      `${node.id} is outward-facing: a policy ${what} must be set with --set-authorship human (recorded as the human's act), never by an agent`);
  }
  if (!nonEmptyObject(constraints)) {
    fail('OUTWARD_POLICY_REQUIRES_CONSTRAINTS',
      `${node.id} is outward-facing: a policy ${what} requires non-empty constraints (at minimum a surface allowlist and an expiry)`);
  }
}

function parseJsonFlag(value, label) {
  if (value === undefined || value === null || value === '') return {};
  let parsed;
  try {
    parsed = typeof value === 'object' ? value : JSON.parse(value);
  } catch (error) {
    fail('INVALID_ARGUMENT', `${label} must be valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('INVALID_ARGUMENT', `${label} must be a JSON object`);
  }
  return parsed;
}

function setGatePolicy(db, input) {
  migrateFabric(db);
  const node = configurableNode(requiredText(input.gateId, '--gate-id'));
  const mode = requiredText(input.mode, '--mode');
  if (!node.allowedModes.includes(mode)) {
    fail('INVALID_MODE', `${node.id} accepts modes ${node.allowedModes.join(', ')}; got ${mode}`);
  }
  const setBy = requiredText(input.setBy, '--set-by');
  const setAuthorship = requiredText(input.setAuthorship, '--set-authorship');
  if (!['human', 'agent'].includes(setAuthorship)) fail('INVALID_ARGUMENT', "--set-authorship must be 'human' or 'agent'");
  const rules = parseJsonFlag(input.rules, '--rules-json');
  const constraints = parseJsonFlag(input.constraints, '--constraints-json');
  const notify = parseJsonFlag(input.notify, '--notify-json');
  assertOutwardPolicyAllowed(node, mode, setAuthorship, constraints, 'revision');

  const current = currentGatePolicy(db, node.id);
  const expectedRaw = input.expectedCurrentRevisionId;
  if (expectedRaw === undefined || expectedRaw === null || expectedRaw === '') {
    fail('INVALID_ARGUMENT', '--expected-current-revision-id is required (the current revision id, or "none")');
  }
  const expected = String(expectedRaw) === 'none' ? null : Number(expectedRaw);
  if ((current?.id ?? null) !== expected) {
    fail('STALE_GATE_REVISION',
      `Gate ${node.id} current revision is ${current?.id ?? 'none'}, not ${expected ?? 'none'}; re-read \`fabric gates\` before changing it`);
  }
  const info = db.prepare(`
    INSERT INTO fabric_gate_policy_revisions
      (gate_id, mode, rules_json, constraints_json, notify_json, set_by, set_authorship, note)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(node.id, mode, JSON.stringify(rules), JSON.stringify(constraints), JSON.stringify(notify),
    setBy, setAuthorship, input.note ?? null);
  return { revision: parseStored(db.prepare('SELECT * FROM fabric_gate_policy_revisions WHERE id=?').get(info.lastInsertRowid)) };
}

function setGateOverride(db, input) {
  migrateFabric(db);
  const node = configurableNode(requiredText(input.gateId, '--gate-id'));
  const subjectKind = node.subjectKind;
  const subjectId = positiveId(input.subjectId, subjectKind === 'application' ? '--application-id' : '--opportunity-id');
  const table = subjectKind === 'application' ? 'applications' : 'opportunities';
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(subjectId)) {
    fail('NOT_FOUND', `${subjectKind} ${subjectId} not found`);
  }
  let mode = null;
  if (!input.clear) {
    mode = requiredText(input.mode, '--mode (or pass --clear to remove the override)');
    if (!node.allowedModes.includes(mode)) {
      fail('INVALID_MODE', `${node.id} accepts modes ${node.allowedModes.join(', ')}; got ${mode}`);
    }
  }
  const setBy = requiredText(input.setBy, '--set-by');
  const setAuthorship = requiredText(input.setAuthorship, '--set-authorship');
  if (!['human', 'agent'].includes(setAuthorship)) fail('INVALID_ARGUMENT', "--set-authorship must be 'human' or 'agent'");
  // An override can only NARROW toward safety on outward gates: policy via
  // override follows the same invariant as policy via revision.
  assertOutwardPolicyAllowed(node, mode, setAuthorship, parseJsonFlag(input.constraints, '--constraints-json'), 'override');
  if (node.outward && mode === 'policy') {
    fail('OUTWARD_POLICY_REQUIRES_REVISION',
      `${node.id} is outward-facing: enable policy through \`fabric gates set\` (a full revision with constraints), not a per-subject override`);
  }
  const reason = requiredText(input.reason, '--reason');
  const info = db.prepare(`
    INSERT INTO fabric_gate_overrides (gate_id, subject_kind, subject_id, mode, reason, set_by, set_authorship)
    VALUES (?,?,?,?,?,?,?)
  `).run(node.id, subjectKind, subjectId, mode, reason, setBy, setAuthorship);
  return { override: db.prepare('SELECT * FROM fabric_gate_overrides WHERE id=?').get(info.lastInsertRowid), cleared: mode === null };
}

/**
 * The behavior a configurable node has RIGHT NOW for a subject. Precedence:
 * subject override > current revision > fail-closed default. Defense in
 * depth: a stored policy revision on an outward gate that no longer satisfies
 * invariant 2 resolves to 'human' with a named refusal instead of acting.
 */
function resolveGateBehavior(db, gateId, subject = null) {
  const node = configurableNode(gateId);
  const override = subject
    ? currentGateOverride(db, gateId, node.subjectKind, subject.id)
    : null;
  if (override) {
    return {
      gateId: node.id, mode: override.mode, source: 'override', overrideId: override.id,
      reason: override.reason, rules: {}, constraints: {}, notify: {}
    };
  }
  const revision = currentGatePolicy(db, gateId);
  if (revision) {
    if (node.outward && revision.mode === 'policy'
      && (revision.set_authorship !== 'human' || !nonEmptyObject(revision.constraints))) {
      return {
        gateId: node.id, mode: 'human', source: 'refused-revision', revisionId: revision.id,
        refusal: 'stored policy revision violates the outward-gate invariant (human-set + constraints); resolving fail-closed to human',
        rules: {}, constraints: {}, notify: {}
      };
    }
    return {
      gateId: node.id, mode: revision.mode, source: 'revision', revisionId: revision.id,
      rules: revision.rules, constraints: revision.constraints, notify: revision.notify
    };
  }
  return { gateId: node.id, mode: node.defaultMode, source: 'default', rules: {}, constraints: {}, notify: {} };
}

function listGateConfiguration(db) {
  migrateFabric(db);
  return FABRIC_NODES.filter((node) => node.configurable).map((node) => {
    const resolved = resolveGateBehavior(db, node.id);
    const overrides = db.prepare(`
      SELECT o.* FROM fabric_gate_overrides o
      WHERE o.gate_id=? AND o.id IN (
        SELECT MAX(id) FROM fabric_gate_overrides WHERE gate_id=o.gate_id GROUP BY subject_kind, subject_id
      ) AND o.mode IS NOT NULL ORDER BY o.subject_id
    `).all(node.id);
    return {
      gateId: node.id,
      title: node.title,
      kind: node.kind,
      outward: node.outward === true,
      allowedModes: node.allowedModes,
      defaultMode: node.defaultMode,
      resolved,
      overrides
    };
  });
}

// ---------------------------------------------------------------------------
// derivation
// ---------------------------------------------------------------------------

const TERMINAL_STAGES = new Set(['declined', 'archived']);
const TERMINAL_STATUSES = new Set(['rejected', 'withdrawn']);
const ASSESSMENT_APPROVED_STAGES = new Set(['assessment_approved', 'letter_drafted', 'package_ready', 'submitted']);

function deriveFabricNext(db, options = {}) {
  migrateFabric(db);
  const parkedOnly = options.parked === true;
  const now = clockOf(options.now);
  const subjects = [];

  for (const opportunity of readOpportunitySubjects(db, options)) {
    subjects.push(deriveOpportunity(db, opportunity));
  }
  for (const application of readApplicationSubjects(db, options)) {
    try {
      subjects.push(deriveApplication(db, application, now));
    } catch (error) {
      subjects.push({
        subjectKind: 'application',
        subjectId: application.id,
        label: `${application.company} — ${application.role}`,
        error: { code: error.code || 'DERIVATION_FAILED', message: error.message },
        items: []
      });
    }
  }

  for (const subject of subjects) {
    if (parkedOnly) subject.items = subject.items.filter((item) => item.status === 'parked');
  }
  const kept = subjects.filter((subject) => subject.items.length > 0 || subject.error || (!parkedOnly && subject.note));
  const all = kept.flatMap((subject) => subject.items);
  const nextWakeAt = earliestWakeAt(kept, now);
  return {
    schemaVersion: FABRIC_NEXT_SCHEMA,
    generatedAt: now.toISOString(),
    parkedOnly,
    // The earliest instant at which time alone changes this picture (a retry
    // window ending, an approval expiring): the wake spine's due-at.
    nextWakeAt,
    subjects: kept,
    summary: {
      subjects: kept.length,
      eligible: all.filter((item) => item.status === 'eligible').length,
      parked: all.filter((item) => item.status === 'parked').length,
      standing: all.filter((item) => item.status === 'standing').length,
      blocked: all.filter((item) => item.status === 'blocked').length,
      errors: kept.filter((subject) => subject.error).length
    }
  };
}

function readOpportunitySubjects(db, options) {
  if (options.applicationId) return [];
  if (!tableExists(db, 'opportunities')) return [];
  if (options.opportunityId) {
    const row = db.prepare('SELECT * FROM opportunities WHERE id=?').get(positiveId(options.opportunityId, '--opportunity-id'));
    if (!row) fail('NOT_FOUND', `Opportunity ${options.opportunityId} not found`);
    return [row];
  }
  return db.prepare("SELECT * FROM opportunities WHERE state IN ('inbox','shortlisted','watching') ORDER BY id").all();
}

function readApplicationSubjects(db, options) {
  if (options.opportunityId) return [];
  if (options.applicationId) {
    const row = db.prepare('SELECT * FROM applications WHERE id=?').get(positiveId(options.applicationId, '--application-id'));
    if (!row) fail('NOT_FOUND', `Application ${options.applicationId} not found`);
    return [row];
  }
  return db.prepare(`
    SELECT * FROM applications
    WHERE (workflow_stage NOT IN ('declined','archived') AND status NOT IN ('rejected','withdrawn'))
      ${tableExists(db, 'job_email_reply_intents') ? 'OR id IN (SELECT application_id FROM job_email_reply_intents)' : ''}
    ORDER BY id
  `).all();
}

function deriveOpportunity(db, opportunity) {
  const subject = {
    subjectKind: 'opportunity',
    subjectId: opportunity.id,
    label: `${opportunity.company_name} — ${opportunity.title}`,
    state: opportunity.state,
    items: []
  };
  const triageCount = tableExists(db, 'opportunity_triage')
    ? db.prepare('SELECT COUNT(*) AS n FROM opportunity_triage WHERE opportunity_id=?').get(opportunity.id).n
    : 0;
  if (triageCount === 0) {
    subject.items.push(workItem('opportunity.triage', {
      reason: 'no triage recorded — score, rationale, and evidence are missing',
      commands: [
        `jobtrack opportunity show --opportunity-id ${opportunity.id} --json`,
        `jobtrack opportunity triage --opportunity-id ${opportunity.id} --decision shortlist|watch|dismiss --rationale "…" --score 0..1 --scorer-kind agent --scorer-id <worker> --json`
      ],
      idempotencyKey: `fabric-opportunity.triage-${opportunity.id}-v1`
    }));
    return subject;
  }
  const latestTriage = db.prepare(
    'SELECT score, score_coverage, hard_blockers_json, created_at FROM opportunity_triage WHERE opportunity_id=? ORDER BY id DESC LIMIT 1'
  ).get(opportunity.id);
  // The posting was observed again AFTER the last triage (a re-ingest that
  // corrected the title, a refreshed snapshot): a real applicant re-reads a
  // changed posting, so the fabric asks for a fresh triage instead of letting
  // the pursue gate keep judging stale evidence (first arc, 2026-09-02: the
  // operator's ingest carried the wrong title; the agent scored the mismatch
  // 0.48 and the gate held forever after the record was corrected).
  const seenAgain = latestTriage?.created_at && opportunity.last_seen_at
    && Date.parse(opportunity.last_seen_at) > Date.parse(latestTriage.created_at) + 1000
    && opportunity.state !== 'dismissed';
  if (seenAgain) {
    subject.items.push(workItem('opportunity.triage', {
      reason: `posting observed again at ${opportunity.last_seen_at} after the last triage (${latestTriage.created_at}) — title now "${opportunity.title}"; re-triage on the current posting`,
      commands: [
        `jobtrack opportunity show --opportunity-id ${opportunity.id} --json`,
        `jobtrack opportunity triage --opportunity-id ${opportunity.id} --decision shortlist|watch|dismiss --rationale "…" --score 0..1 --scorer-kind agent --scorer-id <worker> --json`
      ],
      idempotencyKey: `fabric-opportunity.triage-${opportunity.id}-seen-${String(opportunity.last_seen_at).replace(/[^0-9]/g, '').slice(0, 14)}`
    }));
    return subject;
  }
  const behavior = resolveGateBehavior(db, 'opportunity.pursue', { id: opportunity.id });
  subject.items.push(gateItem('opportunity.pursue', behavior, {
    reason: opportunity.state === 'watching'
      ? `triaged (${triageCount} record(s)); state is 'watching' — revisit deliberately or dismiss`
      : `triaged (${triageCount} record(s)); pursue (promote to an application), keep watching, or dismiss`,
    commands: [
      `jobtrack opportunity promote --opportunity-id ${opportunity.id} --json`,
      `jobtrack opportunity triage --opportunity-id ${opportunity.id} --decision dismiss --rationale "…" --scorer-kind human --json`
    ],
    act: {
      opportunityId: opportunity.id,
      latestTriage: {
        score: latestTriage?.score ?? null,
        coverage: latestTriage?.score_coverage ?? null,
        hardBlockers: safeJsonArray(latestTriage?.hard_blockers_json)
      }
    }
  }));
  return subject;
}

function deriveApplication(db, application, now = new Date()) {
  const subject = {
    subjectKind: 'application',
    subjectId: application.id,
    label: `${application.company} — ${application.role}`,
    workflowStage: application.workflow_stage,
    items: []
  };
  // Independent of preparation mode, lifecycle stage, link retraction or risk:
  // ordinary work may retire, but physical-send reconciliation must stay visible.
  // This read-only branch never probes credentials or offers a send command.
  for (const intent of listReplyIntents(db, { applicationId: application.id }).filter(row => row.reconcileOnly)) {
    subject.items.push({ ...workItem('email.reply', {
      instance: `message ${intent.messageRefId}`,
      reason: `reply intent ${intent.replyIntentId} requires authenticated send reconciliation; no send retry or fence release is authorized${intent.status === 'superseded' ? '; the obsolete intent is superseded but its uncertain send remains unresolved' : ''}`,
      commands: [], idempotencyKey: `fabric-email.reply-reconcile-${intent.replyIntentId}`,
      act: { messageRefId: intent.messageRefId, replyIntentId: intent.replyIntentId,
        replyIntentStatus: intent.status, reconcileOnly: true, reconciliationReason: intent.reconciliationReason }
    }), status: 'blocked' });
  }
  if (TERMINAL_STAGES.has(application.workflow_stage) || TERMINAL_STATUSES.has(application.status)) {
    subject.note = `terminal (${application.workflow_stage}/${application.status})`;
    return subject;
  }
  const planMode = readPlanMode(db, application.id);
  if (planMode && planMode !== 'managed') {
    // The PREPARATION half drives only managed applications. The lifecycle
    // half does not care how the application was prepared: an interview a
    // person logged by hand on a legacy-import application is fabric work too.
    subject.note = `preparation mode '${planMode}' — the fabric drives only managed applications`;
  } else {
    derivePreparation(db, application, subject, planMode);
  }
  // Interviews and offers are events on any live application, whichever
  // preparation stage recorded them (a person can log an interview by hand).
  deriveInterviews(db, application, subject, now);
  deriveOffer(db, application, subject, now);
  return subject;
}

/** The application half — intake through the submission lane — as it was; returns nothing, it fills `subject`. */
function derivePreparation(db, application, subject, planMode) {
  if (application.workflow_stage === 'submitted') {
    deriveSubmitted(db, application, subject);
    return;
  }

  const artifacts = readArtifactCounts(db, application.id);
  if (artifacts.posting === 0) {
    subject.items.push(workItem('application.intake', {
      reason: 'no posting artifact — capture the posting text and its skill requirements first',
      commands: [
        `jobtrack capture-posting --application-id ${application.id} --content-file posting.txt --source-url "…" --json`,
        `jobtrack catalog posting add-skill-requirement --posting-id <id> --skill-id <id> --requirement-kind required --raw-phrase "…" --json`
      ],
      idempotencyKey: `fabric-application.intake-${application.id}-v1`
    }));
    return;
  }
  if (artifacts.research === 0) {
    subject.items.push(workItem('application.research', {
      reason: 'posting captured; no research artifact yet',
      commands: [`jobtrack add-research --application-id ${application.id} --source-url "…" --citation "…" --notes "…" --json`],
      idempotencyKey: `fabric-application.research-${application.id}-v1`
    }));
    return;
  }
  const assessment = db.prepare('SELECT id FROM application_assessments WHERE application_id=? ORDER BY id DESC LIMIT 1').get(application.id);
  if (!assessment) {
    subject.items.push(workItem('application.assess', {
      reason: 'posting + research present; no assessment recorded',
      commands: [`jobtrack assess-application --application-id ${application.id} --company-assessment "…" --role-fit "…" --risks "…" --evidence "…" --open-questions "…" --approach "…" --json`],
      idempotencyKey: `fabric-application.assess-${application.id}-v1`
    }));
    return;
  }
  if (!ASSESSMENT_APPROVED_STAGES.has(application.workflow_stage)) {
    const behavior = resolveGateBehavior(db, 'application.assessment-review', { id: application.id });
    subject.items.push(gateItem('application.assessment-review', behavior, {
      reason: `assessment #${assessment.id} awaits review (stage ${application.workflow_stage})`,
      commands: [`jobtrack review-assessment --application-id ${application.id} --decision approved --decided-by <actor> --notes "…" --json`],
      act: { applicationId: application.id, assessmentId: assessment.id }
    }));
    return;
  }

  // Past the assessment gate. Materials, form, package, and the submission
  // lane all read through the preparation plan; a missing plan just means no
  // materials act has run yet — the first draft creates it lazily.
  deriveMaterials(db, application, subject, planMode !== null);
  derivePackaging(db, application, subject, planMode !== null);
  deriveSubmissionLane(db, application, subject);
}

function deriveMaterials(db, application, subject, planExists) {
  let readiness = null;
  if (planExists) {
    readiness = getApplicationReadiness(db, application.id);
    subject.readiness = { ready: readiness.ready, blockers: readiness.blockers.map((b) => b.code) };
    const uncertain = readiness.blockers.some((blocker) => blocker.code === 'FORM_COVERAGE_UNCERTAIN');
    if (uncertain) {
      subject.items.push(workItem('application.form-recon', {
        reason: 'form coverage is uncertain: observe the apply surface and import its form, or accept the uncertainty',
        commands: [`jobtrack application-form import --input form-observation.json --imported-by <worker> --idempotency-key fabric-application.form-recon-${application.id}-v1 --json`],
        idempotencyKey: `fabric-application.form-recon-${application.id}-v1`
      }));
      const behavior = resolveGateBehavior(db, 'application.uncertainty-accept', { id: application.id });
      subject.items.push(gateItem('application.uncertainty-accept', behavior, {
        reason: 'no reviewable form exists; accepting uncertainty is an explicit act with the current form-state sha',
        commands: [`jobtrack application-material accept-uncertainty --application-id ${application.id} --accepted-by <actor> --reason "…" --expected-form-state-sha256 ${readiness.form?.stateSha256 ?? '<from readiness>'} --idempotency-key fabric-application.uncertainty-accept-${application.id}-v1 --json`],
        act: { applicationId: application.id, formStateSha256: readiness.form?.stateSha256 ?? null }
      }));
    }
    const formUnreviewed = readiness.blockers.some((blocker) => String(blocker.code || '').startsWith('FORM_') && blocker.code !== 'FORM_COVERAGE_UNCERTAIN');
    if (formUnreviewed) {
      const behavior = resolveGateBehavior(db, 'application.form-review', { id: application.id });
      subject.items.push(gateItem('application.form-review', behavior, {
        reason: `form state blocks readiness: ${readiness.blockers.filter((b) => String(b.code || '').startsWith('FORM_')).map((b) => b.code).join(', ')}`,
        commands: [`jobtrack application-form review --revision-id <id> --decision approved --reviewed-by <actor> --rationale "…" --expected-current-revision-id none --expected-review-id none --idempotency-key fabric-application.form-review-${application.id}-v1 --json`]
      }));
    }
  }

  const materials = planExists ? listApplicationMaterials(db, application.id) : [];
  if (!planExists) {
    for (const kind of ['resume', 'cover-letter']) {
      subject.items.push(draftItem(application, kind, null, 'no preparation plan yet — the first draft creates it'));
    }
    return;
  }
  for (const material of materials) {
    const kindLabel = material.form_field_id ? `${material.kind} (field ${material.form_field_id})` : material.kind;
    const revisions = material.revisions || [];
    const head = revisions.find((revision) => revision.is_head) || revisions[0] || null;
    if (!head) {
      subject.items.push(draftItem(application, material.kind, material.form_field_id, 'no revisions'));
      continue;
    }
    if (head.revision_stage !== 'final-candidate') {
      subject.items.push(draftItem(application, material.kind, material.form_field_id,
        `head revision ${head.id} is ${head.revision_stage} — refine to final-candidate`));
      continue;
    }
    const render = (head.latest_review_approved && head.latest_review_render_id
      ? (head.renders || []).find((candidate) => candidate.id === head.latest_review_render_id)
      : (head.renders || [])[0]) || null;
    const lint = render ? latestRenderLintSummary(db, render.id) : null;
    if (material.kind !== 'form-answer' && render && lint && !lint.stale && lint.verdict !== 'pass') {
      // A current FAILING lint is a content problem, not a rendering problem:
      // re-rendering the same payload would churn forever. The draft needs work.
      const lintErrors = (lint.findings || []).filter((finding) => finding && finding.severity === 'error');
      subject.items.push(draftItem(application, material.kind, material.form_field_id,
        reviseAfterLintReason(render.id, lint.error_count, lintErrors),
        { act: { renderId: render.id, lintFindings: lintErrors.slice(0, 6).map(boundedLintFinding) } }));
      continue;
    }
    const needsRender = material.kind !== 'form-answer' && !render;
    const needsLint = material.kind !== 'form-answer' && render && (!lint || lint.stale);
    if (needsRender || needsLint) {
      subject.items.push(workItem('application.materials.render-lint', {
        instance: kindLabel,
        reason: needsRender
          ? `final-candidate ${head.id} has no render`
          : `render ${render.id} lint is ${lint ? 'stale' : 'missing'}`,
        commands: [
          `jobtrack application-material render --application-id ${application.id} --revision-id ${head.id} --expected-content-sha256 ${head.content_sha256} --rendered-by fabric --idempotency-key fabric-render-${head.id}-v1 --json`,
          `jobtrack application-material lint --application-id ${application.id} --render-id <render-id> --linted-by fabric --idempotency-key fabric-lint-${head.id}-v1 --json`
        ],
        idempotencyKey: `fabric-application.materials.render-lint-${head.id}-v1`,
        act: {
          applicationId: application.id, revisionId: head.id, contentSha256: head.content_sha256,
          renderId: render?.id ?? null, needsRender, needsLint
        }
      }));
      continue;
    }
    // Public material metadata intentionally omits payload/template provenance;
    // read only the template selector needed here, not protected field content.
    const templateKey = material.kind === 'resume'
      ? db.prepare('SELECT template_key FROM application_material_revisions WHERE id=?').get(head.id)?.template_key
      : null;
    const editorial = isCompactResumeTemplate(templateKey)
      ? require('./application-resume-editorial').applicationResumeEditorialReadiness(db, { ...head, template_key: templateKey }, render?.id)
      : { required: false, ready: true };
    if (editorial.blockerCodes?.includes('EDITORIAL_SOURCE_STALE')) {
      subject.items.push(draftItem(application, material.kind, material.form_field_id,
        `source evidence for resume ${head.id} changed; regenerate from fresh selected context before editorial review`));
      continue;
    }
    // An independent reviewer asked for changes: that is drafting work, not a
    // parked gate. The revise item carries the reviewer's must-fix notes the
    // same way a lint failure carries its findings, so the worker never
    // revises blind, and the revised final-candidate gets a fresh review.
    if (editorial.blockerCodes?.includes('RESUME_EDITORIAL_CHANGES_REQUESTED') && editorial.reviewId) {
      const feedback = editorialReviseFeedback(db, editorial.reviewId);
      subject.items.push(draftItem(application, material.kind, material.form_field_id,
        reviseAfterEditorialReason(head.id, render?.id ?? null, editorial.reviewId, feedback),
        { act: { renderId: render?.id ?? null, editorialReviewId: editorial.reviewId, editorialFindings: feedback.findings } }));
      continue;
    }
    if (!head.latest_review_approved || !editorial.ready) {
      const behavior = resolveGateBehavior(db, 'application.materials.review', { id: application.id });
      subject.items.push(gateItem('application.materials.review', behavior, {
        instance: kindLabel,
        reason: `final-candidate ${head.id}${render ? ` (render ${render.id}, lint pass)` : ''} awaits ${isCompactResumeTemplate(templateKey) ? 'independent editorial and material' : 'material'} review`,
        commands: [
          ...(isCompactResumeTemplate(templateKey) && render ? [
            `jobtrack application-material editorial-context --application-id ${application.id} --revision-id ${head.id} --render-id ${render.id} --json`,
            `jobtrack application-material editorial-review --application-id ${application.id} --revision-id ${head.id} --render-id ${render.id} --review-file <independent-review.json> --reviewed-by <independent-reviewer> --idempotency-key fabric-editorial-${head.id}-${render.id}-after-${editorial.reviewId ?? 'none'} --json`
          ] : []),
          ...(!head.latest_review_approved ? [`jobtrack application-material review --application-id ${application.id} --revision-id ${head.id}${render ? ` --render-id ${render.id}` : ''} --decision approved --reviewed-by <actor> --expected-review-id ${head.latest_review_id ?? 'none'} --idempotency-key fabric-review-${head.id}-${head.latest_review_id ? `after-${head.latest_review_id}` : 'v1'} --json`] : [])
        ],
        act: {
          applicationId: application.id, revisionId: head.id, renderId: render?.id ?? null,
          expectedReviewId: head.latest_review_id ?? null, lintWarnCount: lint?.warn_count ?? null,
          editorialOnly: Boolean(head.latest_review_approved)
        }
      }));
      continue;
    }
    if (material.selected_revision_id !== head.id) {
      const behavior = resolveGateBehavior(db, 'application.materials.select', { id: application.id });
      subject.items.push(gateItem('application.materials.select', behavior, {
        instance: kindLabel,
        reason: `approved revision ${head.id} is not the current selection (${material.selected_revision_id ?? 'none selected'})`,
        commands: [`jobtrack application-material select --application-id ${application.id} --revision-id ${head.id} --selected-by <actor> --expected-selected-revision-id ${material.selected_revision_id ?? 'none'} --idempotency-key fabric-select-${head.id}-v1 --json`],
        act: {
          applicationId: application.id, revisionId: head.id,
          expectedSelectedRevisionId: material.selected_revision_id ?? null
        }
      }));
    }
  }
}

/** A lint finding as a worker may see it: code, severity, message, evidence — bounded, nothing else. */
function boundedLintFinding(finding) {
  const clip = (value, max) => (typeof value === 'string' ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : undefined);
  return {
    code: clip(finding.code, 80) ?? 'UNKNOWN',
    severity: finding.severity,
    ...(clip(finding.message, 400) ? { message: clip(finding.message, 400) } : {}),
    ...(clip(finding.evidence, 400) ? { evidence: clip(finding.evidence, 400) } : {})
  };
}

/**
 * The revise item's reason names the failing findings (up to three), so the
 * drafting worker knows WHAT to change. Before 2026-09-02 it said only
 * "N error(s)" and workers revised blind until the drill stalled.
 */
function reviseAfterLintReason(renderId, errorCount, lintErrors) {
  const named = lintErrors.slice(0, 3).map((finding) => {
    const bounded = boundedLintFinding(finding);
    return `${bounded.code}: ${bounded.message ?? '(no message)'}${bounded.evidence ? ` [${bounded.evidence}]` : ''}`;
  });
  const more = lintErrors.length > 3 ? ` (+${lintErrors.length - 3} more)` : '';
  return `render ${renderId} failed lint (${errorCount} error(s)) — revise the payload, then re-render`
    + (named.length ? `. Findings: ${named.join(' | ')}${more}` : '');
}

/** The reviewer's recorded notes and non-demonstrated requirements, bounded,
 * in the same shape the lint-revise path uses (`act.*Findings`). */
function editorialReviseFeedback(db, reviewId) {
  const row = db.prepare('SELECT review_json, reviewed_by FROM application_resume_editorial_reviews WHERE id=?').get(reviewId);
  const findings = [];
  let notes = '';
  try {
    const review = JSON.parse(row?.review_json || '{}');
    notes = typeof review.notes === 'string' ? review.notes : '';
    if (notes.trim()) findings.push(boundedLintFinding({ code: 'EDITORIAL_CHANGES_REQUESTED', severity: 'error', message: notes.slice(0, 1200) }));
    for (const entry of (Array.isArray(review.matrix) ? review.matrix : []).filter((m) => m && m.status !== 'demonstrated').slice(0, 5)) {
      findings.push(boundedLintFinding({ code: `REQUIREMENT_${String(entry.status || '').toUpperCase().replace(/[^A-Z]+/g, '_')}`, severity: 'warn', message: `${entry.requirementId}: ${entry.rationale || ''}`, evidence: entry.stretchReason }));
    }
  } catch { /* an unreadable review still surfaces as a revise item; the reason names the review id */ }
  return { reviewedBy: row?.reviewed_by ?? null, notes, findings };
}

function reviseAfterEditorialReason(headId, renderId, reviewId, feedback) {
  const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
  return `independent editorial review ${reviewId} requested changes to final-candidate ${headId}${renderId ? ` (render ${renderId})` : ''} — revise the payload from the head, then re-render for a fresh review`
    + (feedback.notes.trim() ? `. Reviewer: ${clip(feedback.notes.trim().replace(/\s+/g, ' '), 300)}` : '');
}

function draftItem(application, kind, formFieldId, reason, extra = {}) {
  const instance = formFieldId ? `${kind} (field ${formFieldId})` : kind;
  return workItem('application.materials.draft', {
    instance,
    reason,
    ...(extra.act ? { act: extra.act } : {}),
    commands: [
      `jobtrack application-material context --application-id ${application.id} --kind ${kind}${formFieldId ? ` --form-field-id ${formFieldId}` : ''} --json`,
      `jobtrack application-material draft --application-id ${application.id} --kind ${kind}${formFieldId ? ` --form-field-id ${formFieldId}` : ''} … --json`
    ],
    idempotencyKey: `fabric-application.materials.draft-${application.id}-${instance.replace(/[^a-z0-9-]+/gi, '_')}-v1`
  });
}

function derivePackaging(db, application, subject, planExists) {
  if (!planExists) return;
  const readiness = subject.readiness;
  if (!readiness || !readiness.ready) return;
  const boundPackage = db.prepare(`
    SELECT p.id, p.package_status FROM application_packages p
    JOIN application_package_preparation_snapshots s ON s.application_package_id=p.id
    WHERE p.application_id=? AND p.package_status IN ('ready','submitted') ORDER BY p.id DESC LIMIT 1
  `).get(application.id);
  if (!boundPackage) {
    const full = getApplicationReadiness(db, application.id);
    subject.items.push(workItem('application.package', {
      reason: 'readiness is green and no ready package is bound',
      commands: [`jobtrack build-package --application-id ${application.id} --expected-readiness-sha256 ${full.readinessSha256} --idempotency-key fabric-application.package-${application.id}-v1 --json`],
      idempotencyKey: `fabric-application.package-${application.id}-v1`,
      act: { applicationId: application.id, readinessSha256: full.readinessSha256 }
    }));
    return;
  }
  subject.packageId = boundPackage.id;
}

function deriveSubmissionLane(db, application, subject) {
  if (!subject.packageId) return;
  const state = readSubmissionState(db, application.id);
  if (state.intents.length === 0) {
    const full = getApplicationReadiness(db, application.id);
    const surfaceId = application.job_url || null;
    subject.items.push(workItem('application.submission.propose', {
      reason: `package ${subject.packageId} is ready and no submission intent exists`,
      commands: [`jobtrack application-submission propose --application-id ${application.id} --package-id ${subject.packageId} --expected-readiness-sha256 ${full.readinessSha256} --surface-id "${surfaceId ?? '<apply url>'}" --intent-id fabric-intent-${application.id}-v1 --json`],
      idempotencyKey: `fabric-application.submission.propose-${application.id}-v1`,
      act: {
        applicationId: application.id, packageId: subject.packageId,
        readinessSha256: full.readinessSha256, surfaceId,
        intentId: `fabric-intent-${application.id}-v1`
      }
    }));
    return;
  }
  const intent = state.intents[state.intents.length - 1];
  const approval = state.approvals.find((row) => row.intent_id === intent.intent_id) || null;
  if (!approval) {
    const behavior = resolveGateBehavior(db, 'application.submission.approve', { id: application.id });
    subject.items.push(gateItem('application.submission.approve', behavior, {
      reason: `intent ${intent.intent_id} (digest ${intent.intent_digest.slice(0, 12)}…) awaits approval — one approval frees one attempt`,
      commands: [`jobtrack application-submission approve --intent-id ${intent.intent_id} --expected-intent-digest ${intent.intent_digest} --approver-kind human --approver-id <actor> --approval-id fabric-approval-${application.id}-v1 --json`],
      act: {
        applicationId: application.id, intentId: intent.intent_id,
        intentDigest: intent.intent_digest, surfaceId: intent.surface_id
      }
    }));
    return;
  }
  if (state.unreconciled) {
    subject.items.push({
      ...workItem('application.apply', {
        reason: `attempt ${state.unreconciled.attempt_id} is unreconciled — determine what actually happened and settle it definitively; never retry into ambiguity`,
        commands: [`jobtrack application-submission settle --attempt-id ${state.unreconciled.attempt_id} --outcome accepted|rejected|failed|indeterminate --external-reference "…" --json`],
        idempotencyKey: `fabric-application.apply-${application.id}-reconcile-v1`
      }),
      status: 'blocked'
    });
    return;
  }
  if (state.landed) {
    const full = getApplicationReadiness(db, application.id);
    subject.items.push(workItem('application.verify-record', {
      reason: `attempt ${state.landed.attempt_id} landed (${state.landed.outcome}); verify the delivered bytes and record the submission fact`,
      commands: [
        `jobtrack application-material verify-uploads --application-id ${application.id} --resume-file <delivered.pdf> --cover-letter-file <delivered.pdf> --verified-by fabric --idempotency-key fabric-verify-${application.id}-v1 --json`,
        `jobtrack application-material record-submission --application-id ${application.id} --package-id ${subject.packageId} --attempt-id ${state.landed.attempt_id} --submitted-by <worker> --expected-readiness-sha256 ${full.readinessSha256} --idempotency-key fabric-record-${application.id}-v1 --json`
      ],
      idempotencyKey: `fabric-application.verify-record-${application.id}-v1`,
      act: {
        applicationId: application.id, packageId: subject.packageId,
        attemptId: state.landed.attempt_id, readinessSha256: full.readinessSha256
      }
    }));
    return;
  }
  if (state.maySubmit) {
    const behavior = resolveGateBehavior(db, 'application.apply', { id: application.id });
    // A definitive failed/rejected settlement deliberately frees the same
    // approval for another try. Attempt ids and dispatcher idempotency must
    // advance with that append-only history; reusing v1 would only replay the
    // already-settled attempt and make the documented retry impossible.
    const { attemptId, attemptVersion, idempotencyKey } = nextFabricAttemptIdentity(application.id, state.attempts);
    const item = workItem('application.apply', {
      reason: `approval ${approval.approval_id} is live (expires ${approval.expires_at}); claim attempt v${attemptVersion} and drive the surface`,
      commands: [
        `jobtrack application-submission claim --approval-id ${approval.approval_id} --attempt-id ${attemptId} --json`,
        `jobtrack application-submission settle --attempt-id ${attemptId} --outcome accepted|rejected|failed|indeterminate --external-reference "…" --json`
      ],
      idempotencyKey,
      wakeAt: approval.expires_at,
      act: {
        applicationId: application.id,
        approvalId: approval.approval_id,
        approvalExpiresAt: approval.expires_at,
        surfaceId: intent.surface_id,
        attemptId
      }
    });
    item.executor = behavior.mode;
    item.executorSource = behavior.source;
    if (behavior.mode === 'manual') {
      item.status = 'parked';
      item.owner = 'human';
      item.reason += ' — executor is manual: a human drives the surface, then settles the attempt';
    } else if (behavior.mode === 'withhold') {
      item.status = 'parked';
      item.owner = 'operator';
      item.reason += ' — executor withheld: the apply lane is paused';
    }
    subject.items.push(item);
  }
}

/**
 * Pick the next monotonic generated attempt identity across the application.
 * Attempts are append-only and their ids are global, while an application can
 * acquire a newer intent/approval over time. Counting only the current
 * approval could therefore collide with a generated id owned by older
 * approval history.
 */
function nextFabricAttemptIdentity(applicationId, attempts) {
  const escapedApplicationId = String(applicationId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const generated = new RegExp(`^fabric-attempt-${escapedApplicationId}-v([1-9][0-9]*)$`);
  const attemptVersion = attempts.reduce((max, row) => {
    const match = generated.exec(row.attempt_id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
  const attemptId = `fabric-attempt-${applicationId}-v${attemptVersion}`;
  return {
    attemptId,
    attemptVersion,
    idempotencyKey: `fabric-application.apply-${applicationId}-v${attemptVersion}`
  };
}

function deriveSubmitted(db, application, subject) {
  const recorded = db.prepare('SELECT id FROM application_material_submission_events WHERE application_id=?').get(application.id);
  subject.items.push({
    ...workItem('application.watch', {
      reason: recorded
        ? 'submitted and recorded — watch the lifecycle: correlate inbound mail, log interviews/outcomes as they arrive'
        : 'stage is submitted with no recorded submission event (legacy path) — lifecycle watching only',
      commands: [`jobtrack email correlate --input <message.json> --json`],
      idempotencyKey: `fabric-application.watch-${application.id}`
    }),
    status: 'standing'
  });
  deriveInboundEmail(db, application, subject);
  return subject;
}

const DETERMINISTIC_PREP_GENERATOR = 'interview-prep-generator.v1';
const MAX_OFFER_DETAIL_CHARS = 160;

function clockOf(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date();
}

function hoursUntil(iso, now) {
  const ms = Date.parse(iso) - now.getTime();
  return Math.round((ms / 3_600_000) * 10) / 10;
}

function describeInterview(interview) {
  const when = interview.scheduled_at + (interview.timezone ? ` (${interview.timezone})` : '');
  return `${interview.round} ${interview.format} interview #${interview.id} on ${when}`;
}

/**
 * Interviews the store holds for this application that are still open — not
 * cancelled, outcome pending — and what each requires now. Before the
 * interview: a prep analysis (first a deterministic draft, then an
 * evidence-bound one the agent authors, reviewed and selected by a person).
 * After it: the outcome, recorded by a person. Every act is an existing
 * interview-prep verb; the fabric only says which one is due.
 */
function deriveInterviews(db, application, subject, now) {
  if (!tableExists(db, 'interviews') || !tableExists(db, 'interview_prep_analyses')) return;
  const interviews = db.prepare(`
    SELECT * FROM interviews
    WHERE application_id=? AND outcome='pending' AND COALESCE(scheduling_status,'scheduled') NOT IN ('cancelled','completed')
    ORDER BY datetime(scheduled_at), id
  `).all(application.id);
  for (const interview of interviews) {
    const startMs = Date.parse(interview.scheduled_start_utc || interview.scheduled_at);
    if (!Number.isFinite(startMs)) continue;
    const endAt = new Date(startMs + (interview.duration_minutes || 60) * 60_000).toISOString();
    const instance = `interview ${interview.id}`;
    const label = describeInterview(interview);
    const act = {
      applicationId: application.id,
      interviewId: interview.id,
      round: interview.round,
      format: interview.format,
      scheduledAt: interview.scheduled_at,
      timezone: interview.timezone ?? null,
      durationMinutes: interview.duration_minutes ?? null,
      endsAt: endAt
    };
    if (now.getTime() >= Date.parse(endAt)) {
      subject.items.push({
        ...workItem('interview.outcome', {
          instance,
          reason: `the ${label} has passed — record how it went`,
          commands: [`jobtrack update-interview --interview-id ${interview.id} --outcome passed|failed --notes "…" --json`],
          idempotencyKey: `fabric-interview.outcome-${interview.id}`,
          act
        }),
        status: 'parked',
        owner: 'human'
      });
      continue;
    }
    const hours = hoursUntil(new Date(startMs).toISOString(), now);
    const analyses = db.prepare('SELECT * FROM interview_prep_analyses WHERE interview_id=? ORDER BY version').all(interview.id);
    const current = db.prepare('SELECT analysis_id FROM interview_prep_current WHERE interview_id=?').get(interview.id);
    const currentAnalysis = current ? analyses.find((row) => row.id === current.analysis_id) ?? null : null;
    if (analyses.length === 0) {
      subject.items.push(workItem('interview.prep.generate', {
        instance,
        reason: `${label} in ${hours}h; no prep analysis yet — generate the deterministic first draft`,
        commands: [`jobtrack interview-prep generate --interview-id ${interview.id} --generated-by fabric --idempotency-key fabric-interview.prep.generate-${interview.id} --json`],
        idempotencyKey: `fabric-interview.prep.generate-${interview.id}`,
        act
      }));
      continue;
    }
    const authored = analyses.filter((row) => row.generator_version !== DETERMINISTIC_PREP_GENERATOR);
    const latest = analyses[analyses.length - 1];
    const review = db.prepare(`
      SELECT event_kind, actor, notes, created_at FROM interview_prep_events
      WHERE analysis_id=? AND event_kind IN ('approved','rejected') ORDER BY id DESC LIMIT 1
    `).get(latest.id) ?? null;
    const currentStale = currentAnalysis ? isInterviewPrepAnalysisStale(db, currentAnalysis.id) : true;
    // The state machine over the LATEST analysis: no authored one yet → author;
    // rejected → author again; unreviewed → review gate; approved but not
    // current → select gate; approved, current and stale → author afresh;
    // otherwise prep is ready and the interview is simply upcoming.
    const needsAuthor = authored.length === 0
      || review?.event_kind === 'rejected'
      || (review?.event_kind === 'approved' && currentAnalysis?.id === latest.id && currentStale);
    const authorAct = {
      ...act,
      currentAnalysisId: currentAnalysis?.id ?? null,
      currentGeneratedBy: currentAnalysis?.generated_by ?? null,
      currentStale,
      latestAnalysisId: latest.id,
      ...(review?.event_kind === 'rejected' ? { rejectedAnalysisId: latest.id, reviewNotes: review.notes ?? null, reviewedBy: review.actor } : {})
    };
    if (needsAuthor) {
      const version = analyses.length + 1;
      subject.items.push(workItem('interview.prep.author', {
        instance,
        reason: review?.event_kind === 'rejected'
          ? `${label} in ${hours}h; analysis #${latest.id} was rejected by ${review.actor}${review.notes ? ` (${review.notes.slice(0, 120)})` : ''} — author a better one`
          : authored.length === 0
            ? `${label} in ${hours}h; only the deterministic draft (#${currentAnalysis?.id ?? latest.id}) exists — author an evidence-bound analysis`
            : `${label} in ${hours}h; the current analysis #${currentAnalysis.id} is stale (its evidence changed) — author a fresh one`,
        commands: [
          `jobtrack interview-prep context --interview-id ${interview.id} --json`,
          `jobtrack interview-prep create --interview-id ${interview.id} --analysis-file prep.json --generated-by fabric-worker --idempotency-key fabric-interview.prep.author-${interview.id}-v${version} --json`
        ],
        idempotencyKey: `fabric-interview.prep.author-${interview.id}-v${version}`,
        act: authorAct
      }));
      continue;
    }
    if (review === null) {
      const behavior = resolveGateBehavior(db, 'interview.prep.review', { id: application.id });
      subject.items.push(gateItem('interview.prep.review', behavior, {
        instance,
        reason: `${label} in ${hours}h; analysis #${latest.id} v${latest.version} by ${latest.generated_by} awaits review`,
        commands: [`jobtrack interview-prep review --analysis-id ${latest.id} --decision approved|rejected --reviewed-by <actor> --notes "…" --idempotency-key fabric-interview.prep.review-${latest.id} --json`],
        act: { ...act, analysisId: latest.id, analysisVersion: latest.version, generatedBy: latest.generated_by }
      }));
      continue;
    }
    if (review.event_kind === 'approved' && (!currentAnalysis || currentAnalysis.id !== latest.id)) {
      const behavior = resolveGateBehavior(db, 'interview.prep.select', { id: application.id });
      subject.items.push(gateItem('interview.prep.select', behavior, {
        instance,
        reason: `${label} in ${hours}h; analysis #${latest.id} is approved but #${currentAnalysis?.id ?? 'none'} is still current — select it`,
        commands: [`jobtrack interview-prep select --analysis-id ${latest.id} --selected-by <actor> --expected-current-analysis-id ${currentAnalysis?.id ?? 'none'} --idempotency-key fabric-interview.prep.select-${latest.id} --json`],
        act: { ...act, analysisId: latest.id, expectedCurrentAnalysisId: currentAnalysis?.id ?? null }
      }));
      continue;
    }
    subject.items.push({
      ...workItem('interview.upcoming', {
        instance,
        reason: `${label} in ${hours}h; prep #${currentAnalysis?.id ?? latest.id} is reviewed and current — record the outcome once it has happened`,
        commands: [`jobtrack interview-prep current --interview-id ${interview.id} --json`],
        idempotencyKey: `fabric-interview.upcoming-${interview.id}`,
        act: { ...act, analysisId: currentAnalysis?.id ?? latest.id }
      }),
      status: 'standing',
      wakeAt: endAt
    });
  }
}

/**
 * A recorded offer with no decision yet parks at the offer gate — a person's
 * decision, always; the gate admits no policy mode. The decision deadline,
 * when the offer carries one, is the wake hint.
 */
function deriveOffer(db, application, subject, now) {
  if (!tableExists(db, 'offers')) return;
  const offer = db.prepare('SELECT * FROM offers WHERE application_id=?').get(application.id);
  if (!offer || offer.outcome !== 'pending') return;
  const deadlineMs = offer.decision_deadline ? Date.parse(offer.decision_deadline) : NaN;
  const deadline = Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null;
  const overdue = deadline !== null && now.getTime() > deadlineMs;
  const behavior = resolveGateBehavior(db, 'offer.decision', { id: application.id });
  const details = String(offer.details ?? '').replace(/\s+/g, ' ').trim();
  const item = gateItem('offer.decision', behavior, {
    reason: `offer recorded ${offer.created_at}${deadline ? `, decide by ${offer.decision_deadline}${overdue ? ' (OVERDUE)' : ''}` : ''}: ${details.length > MAX_OFFER_DETAIL_CHARS ? `${details.slice(0, MAX_OFFER_DETAIL_CHARS)}…` : details}`,
    commands: [
      `jobtrack update-offer --application-id ${application.id} --outcome accepted|declined --json`,
      `jobtrack record-outcome --application-id ${application.id} --status offer|withdrawn --notes "…" --json`
    ],
    act: { applicationId: application.id, offerId: offer.id, decisionDeadline: offer.decision_deadline ?? null, overdue, recordedAt: offer.created_at }
  });
  subject.items.push(deadline !== null && !overdue ? { ...item, wakeAt: deadline } : item);
}

/**
 * Inbound mail the relay linked to this application and nobody has decided on
 * yet (applysim plan L7-B): one agent item per message, oldest first. The
 * agent reads the imported facts, replies through the outgoing lane and/or
 * moves the application through the transition lane, then records its
 * decision — after which the item disappears for that application. An
 * ambiguous message may be considered against more than one candidate before
 * one is selected, so handling and work-item idempotency are scoped to the
 * (message, application) pair.
 */
function deriveInboundEmail(db, application, subject) {
  let queue;
  try {
    queue = listInboundQueue(db, { applicationId: application.id });
  } catch (error) {
    subject.items.push({ ...workItem('email.review', { reason: `inbound queue unreadable: ${error.message}`, commands: [] }), status: 'held' });
    return subject;
  }
  for (const entry of queue) {
    const candidateIds = [...new Set((entry.candidates || []).map((candidate) => candidate.applicationId))];
    const mayClarify = ['ambiguous', 'clarifying'].includes(entry.via) && entry.clarifiable
      && entry.clarification?.status !== 'expired' && candidateIds.length > 1;
    const waitingOnClarification = entry.via === 'clarifying'
      && Boolean(entry.clarification?.askedAt && entry.clarification?.sentMessageId);
    const unsentClarification = entry.via === 'clarifying' && !waitingOnClarification;
    // An ambiguity re-correlated after the record grew is new work even for a
    // candidate the agent judged `none` under the earlier, poorer record.
    const generation = entry.via === 'ambiguous' && entry.correlationId ? `-c${entry.correlationId}` : '';
    const item = workItem('email.review', {
      instance: `message ${entry.messageRefId}`,
      reason: waitingOnClarification
        ? `clarification ${entry.clarification?.clarificationId || ''} is pending in the sender's thread until ${entry.clarification?.expiresAt || 'its policy deadline'} — wait for the answer; do not send a second nudge`
        : unsentClarification
          ? `clarification ${entry.clarification.clarificationId} is unsent — resume the same proposal ${entry.clarification.proposalId} through the external native draft/review/send lane; do not create another question`
        : entry.via === 'ambiguous'
          ? `inbound ${entry.eventKind} from ${entry.source.fromDomain || entry.source.fromAddress || 'unknown sender'} correlates ambiguously (${candidateIds.length} candidate(s))${mayClarify ? ' and expects a reply — ask which role; do not guess' : ' — make a judgment or decide none'}`
          : `inbound ${entry.eventKind} from ${entry.source.fromDomain || entry.source.fromAddress || 'unknown sender'} (received ${entry.source.receivedAt}) awaits the applicant's decision`,
      commands: waitingOnClarification ? [] : [
        `jobtrack email inbound-queue --application-id ${application.id} --json`,
        ...(mayClarify ? [
          `jobtrack email clarify --message-ref-id ${entry.messageRefId} --candidates ${candidateIds.join(',')} --json`
        ] : [
          `jobtrack email mark-handled --message-ref-id ${entry.messageRefId} --application-id ${application.id} --decision <reply|transition|reply_and_transition|none> --actor fabric-worker --authorship agent --reason "…" --idempotency-key fabric-email-handled-${entry.messageRefId}-a${application.id}${generation} --json`
        ])
      ],
      idempotencyKey: `fabric-email.review-${entry.messageRefId}-a${application.id}${generation}-v1`,
      act: {
        messageRefId: entry.messageRefId,
        applicationId: application.id,
        eventKind: entry.eventKind,
        via: entry.via,
        ...(entry.clarifiable !== undefined ? { clarifiable: entry.clarifiable } : {}),
        ...(entry.clarification ? { clarification: entry.clarification } : {}),
        ...(entry.candidates ? { candidates: entry.candidates } : {}),
        source: entry.source,
        securityRisk: entry.securityRisk,
        requiresReview: entry.requiresReview,
        replyRequested: entry.facts?.replyRequested ?? null,
        interview: entry.facts?.interview ?? null,
        requestedAction: entry.facts?.requestedAction ?? null
      }
    });
    subject.items.push(waitingOnClarification ? {
      ...item,
      status: 'blocked',
      ...(entry.clarification?.expiresAt ? { wakeAt: entry.clarification.expiresAt } : {})
    } : item);
  }
  // Unattributed mail whose live correlation now offers this application (arc 2,
  // 2026-09-02: the welcome was recorded unmatched before the subject-mention
  // basis existed) and mail the relay imported without ever recording a
  // correlation (2026-09-03: a stale correlation terminalized the delivery
  // between import and record): a deterministic re-correlation puts either in
  // front of the applicant's agent instead of leaving it invisible.
  let stale;
  try {
    stale = listStaleUnmatched(db, { applicationId: application.id });
  } catch (error) {
    subject.items.push({ ...workItem('email.recorrelate', { reason: `unattributed inbound mail unreadable: ${error.message}`, commands: [] }), status: 'held' });
    return subject;
  }
  for (const entry of stale) {
    const bases = [...new Set(entry.live.candidates.map((candidate) => candidate.matchBasis))].join(', ') || entry.live.resolution;
    // correlationId null = the relay imported the message but never recorded a
    // correlation for it (its record step failed after the import). Such a
    // message is otherwise invisible to every lane, so it is re-correlated too.
    const recorded = entry.correlationId === null
      ? 'was imported but never correlated'
      : entry.recorded === 'ambiguous'
        ? 'was recorded ambiguous before the record grew'
        : entry.recorded === 'linked'
          ? 'was recorded linked before that link was retracted'
          : 'was recorded unmatched';
    subject.items.push(workItem('email.recorrelate', {
      instance: `message ${entry.messageRefId}`,
      reason: `inbound ${entry.eventKind} from ${entry.fromDomain || entry.fromAddress || 'unknown sender'} (received ${entry.receivedAt}) ${recorded}; the current record offers ${entry.live.candidates.length} candidate(s) (${bases}) — re-correlate so the applicant can decide`,
      commands: [],
      idempotencyKey: `fabric-email.recorrelate-${entry.messageRefId}-c${entry.correlationId ?? 0}`,
      act: { messageRefId: entry.messageRefId, correlationId: entry.correlationId, live: entry.live }
    }));
  }
  // Replies still owed (arc 2, 2026-09-02: the invite moved the application to
  // interviewing but its reply failed in the draft recipe). Offered again once
  // per window; BLOCKED — surfaced, never staffed — while this machine cannot
  // send as the account, so a missing mail authorization costs no worker runs.
  let owed;
  try {
    owed = listOutstandingReplies(db, { applicationId: application.id });
  } catch (error) {
    subject.items.push({ ...workItem('email.reply', { reason: `outstanding replies unreadable: ${error.message}`, commands: [] }), status: 'held' });
    return subject;
  }
  for (const entry of owed) {
    const item = workItem('email.reply', {
      instance: `message ${entry.messageRefId}`,
      reason: `the ${entry.eventKind} from ${entry.source.fromDomain || entry.source.fromAddress} (received ${entry.source.receivedAt}) was decided "${entry.decision}" but no reply has been sent${entry.attempts ? ` (${entry.attempts} earlier attempt(s), last ${entry.lastAttemptAt})` : ''}${entry.pendingApproval ? ` — an approved draft (${entry.pendingApproval.approvalId}) is waiting: send it` : ' — write and send it now'}`,
      commands: [
        `jobtrack email inbound-queue --application-id ${application.id} --json`,
        `node scripts/prepare-reply-draft.cjs --source <source.json from act.source> --kind agent --body-file <reply.txt> --reply-subject "<inbound subject>" --applicant-name "<profile name>" --delivery-provider gog_gmail --delivery-account ${entry.source.accountId} --json`
      ],
      idempotencyKey: `fabric-email.reply-${entry.messageRefId}-a${entry.attempts}`,
      act: {
        messageRefId: entry.messageRefId,
        applicationId: application.id,
        eventKind: entry.eventKind,
        decision: entry.decision,
        decisionReason: entry.decisionReason,
        attempts: entry.attempts,
        lastAttemptAt: entry.lastAttemptAt,
        pendingApproval: entry.pendingApproval,
        replyIntentId: entry.replyIntentId,
        replyIntentStatus: entry.replyIntentStatus,
        reconcileOnly: entry.reconcileOnly,
        source: entry.source,
        securityRisk: entry.securityRisk,
        requiresReview: entry.requiresReview,
        interview: entry.facts?.interview ?? null,
        requestedAction: entry.facts?.requestedAction ?? null,
        subjectEvidence: (entry.facts?.evidence ?? []).find((e) => e && e.field === 'subject')?.excerpt ?? null
      }
    });
    if (entry.reconcileOnly) {
      // Already surfaced independently of the application lifecycle above.
      continue;
    }
    if (!entry.intentActive || !entry.intentSendBindingUnambiguous) {
      subject.items.push({ ...item, status: 'blocked', commands: [],
        reason: `reply intent ${entry.replyIntentId} has no sole active application binding; no send is authorized` });
      continue;
    }
    if (entry.coolingDown) {
      subject.items.push({ ...item, status: 'blocked', reason: `${item.reason}; the last attempt was ${entry.lastAttemptAt} — waiting out the retry window before another`, ...(entry.retryAt ? { wakeAt: entry.retryAt } : {}) });
      continue;
    }
    const readiness = transmitReadiness(entry.source.accountId);
    if (!readiness.ready) {
      // Worth another look in ten minutes: the operator may have authorized the account.
      subject.items.push({ ...item, status: 'blocked', reason: `${item.reason}; blocked: ${readiness.detail}`, wakeAt: new Date(Date.now() + 10 * 60_000).toISOString() });
      continue;
    }
    subject.items.push(item);
  }
  return subject;
}

// ---------------------------------------------------------------------------
// the tick (Phase B): one bounded reconciliation pass, in-store acts only
// ---------------------------------------------------------------------------

/**
 * Execute what this process can execute: deterministic work nodes, and
 * policy-mode gates whose rules and constraints hold — each inside its own
 * savepoint so a failing item rolls back cleanly and never leaves a
 * half-applied act behind. Everything else is classified, not touched:
 * parked stays parked, agent work is returned as `dispatchable`, rule
 * failures are `held` with a named reason. The tick NEVER spawns an agent.
 *
 * `services` carries process capabilities: { home, renderLatexMaterial,
 * buildPackage, reviewAssessment }. A missing capability degrades the item
 * to held/dispatchable with a reason — never to a crash.
 */
function runFabricTick(db, options = {}, services = {}) {
  migrateFabric(db);
  const now = clockOf(options.now);
  const derivation = deriveFabricNext(db, { ...options, now });
  const performed = [];
  const held = [];
  const parked = [];
  const dispatchable = [];
  const failed = [];

  for (const subject of derivation.subjects) {
    const ref = { subjectKind: subject.subjectKind, subjectId: subject.subjectId, label: subject.label };
    if (subject.error) {
      failed.push({ ...ref, node: null, error: subject.error });
      continue;
    }
    for (const item of subject.items) {
      const entry = { ...ref, node: item.node, ...(item.instance ? { instance: item.instance } : {}) };
      if (item.status === 'parked') {
        parked.push({ ...entry, mode: item.mode ?? item.executor, owner: item.owner ?? 'human', reason: item.reason });
        continue;
      }
      if (item.status === 'standing') continue;
      if (item.status === 'blocked') {
        // Blocked is "needs reconciliation/inputs", not "needs a worker":
        // dispatchers must treat it as surfaced state, never staff it blind.
        dispatchable.push({ ...entry, blocked: true, reason: item.reason });
        continue;
      }
      const executor = TICK_EXECUTORS[item.node];
      if (!executor) {
        dispatchable.push({ ...entry, reason: item.reason, commands: item.commands });
        continue;
      }
      try {
        // db.transaction inside an open transaction is a savepoint: a throwing
        // executor rolls back its own writes and the tick carries on.
        const outcome = db.transaction(() => executor(db, item, services, now))();
        if (outcome.held) held.push({ ...entry, reason: outcome.held });
        else if (outcome.dispatch) dispatchable.push({ ...entry, reason: outcome.dispatch, commands: item.commands });
        else performed.push({ ...entry, actor: outcome.actor, summary: outcome.summary });
      } catch (error) {
        failed.push({ ...entry, error: { code: error.code || 'EXECUTOR_FAILED', message: error.message } });
      }
    }
  }

  return {
    schemaVersion: FABRIC_TICK_SCHEMA,
    generatedAt: now.toISOString(),
    performed,
    held,
    parked,
    dispatchable,
    failed,
    summary: {
      performed: performed.length,
      held: held.length,
      parked: parked.length,
      dispatchable: dispatchable.length,
      failed: failed.length
    }
  };
}

/** The acting identity a fired policy gate records: auditable to its config. */
function policyActor(item) {
  const source = item.revisionId ? `@rev${item.revisionId}`
    : item.overrideId ? `@override${item.overrideId}` : '@default';
  return `policy:fabric/${item.node}${source}`;
}

/**
 * Gate rules are fail-closed: every present key must be recognized AND hold,
 * or the gate does not fire. An unrecognized key is a refusal, not a shrug —
 * a typo'd rule must never silently widen behavior.
 */
function evaluateRules(rules, known, evaluate) {
  for (const key of Object.keys(rules || {})) {
    if (!known.includes(key)) return `unrecognized rule '${key}' — refusing to fire (known: ${known.join(', ') || 'none'})`;
    const failure = evaluate(key, rules[key]);
    if (failure) return failure;
  }
  return null;
}

/**
 * The outward gate's constraints, enforced again at FIRE time (config-time
 * checks bound what can be stored; this bounds what can happen): a non-empty
 * surface allowlist that matches the intent's surface, and an unexpired
 * expiry. Unknown constraint keys refuse — an unenforceable bound is no bound.
 */
function approveConstraintFailure(constraints, act, now) {
  const known = new Set(['surfaceAllowlist', 'expiresAt']);
  for (const key of Object.keys(constraints || {})) {
    if (!known.has(key)) return `unrecognized constraint '${key}' — refusing to fire (enforceable: ${[...known].join(', ')})`;
  }
  const allow = constraints?.surfaceAllowlist;
  if (!Array.isArray(allow) || allow.length === 0) return 'constraints.surfaceAllowlist must be a non-empty array';
  if (!act.surfaceId || !allow.some((prefix) => typeof prefix === 'string' && act.surfaceId.startsWith(prefix))) {
    return `intent surface ${act.surfaceId ?? '(none)'} is not on the allowlist`;
  }
  const expires = Date.parse(constraints?.expiresAt);
  if (!Number.isFinite(expires)) return 'constraints.expiresAt must be a parseable timestamp';
  if (now.getTime() >= expires) return `policy constraints expired at ${constraints.expiresAt}`;
  return null;
}

const TICK_EXECUTORS = {
  'interview.prep.generate': (db, item) => {
    const created = generateDeterministicPrep(db, item.act.interviewId, { idempotencyKey: item.idempotencyKey, generatedBy: 'fabric' });
    return { actor: 'fabric', summary: `generated prep analysis #${created.analysis.id} v${created.analysis.version} for interview ${item.act.interviewId}` };
  },
  'interview.prep.review': (db, item) => {
    // Policy review approves only analyses whose author the rule names; an
    // empty rule set fires nothing, so a policy revision must say who.
    const allowed = Array.isArray(item.rules?.approveGeneratedBy) ? item.rules.approveGeneratedBy : [];
    const failure = evaluateRules(item.rules, ['approveGeneratedBy'], () => null);
    if (failure) return { held: failure };
    if (!allowed.includes(item.act.generatedBy)) {
      return { held: `rule approveGeneratedBy ${JSON.stringify(allowed)} does not name the author ${item.act.generatedBy}` };
    }
    reviewInterviewPrepAnalysis(db, {
      analysisId: item.act.analysisId, decision: 'approved', reviewedBy: policyActor(item),
      notes: `approved by policy: author ${item.act.generatedBy} is allowed`
    }, { idempotencyKey: `fabric-interview.prep.review-${item.act.analysisId}` });
    return { actor: policyActor(item), summary: `approved prep analysis #${item.act.analysisId} (author ${item.act.generatedBy})` };
  },
  'interview.prep.select': (db, item) => {
    const failure = evaluateRules(item.rules, [], () => null);
    if (failure) return { held: failure };
    selectCurrentInterviewPrep(db, {
      analysisId: item.act.analysisId, selectedBy: policyActor(item),
      expectedCurrentAnalysisId: item.act.expectedCurrentAnalysisId ?? 'none'
    }, { idempotencyKey: `fabric-interview.prep.select-${item.act.analysisId}` });
    return { actor: policyActor(item), summary: `selected prep analysis #${item.act.analysisId} as current` };
  },
  'email.recorrelate': (db, item) => {
    const result = recorrelateFromStore(db, { messageRefId: item.act.messageRefId, idempotencyKey: item.idempotencyKey });
    const correlationId = result?.correlationId ?? result?.result?.correlationId ?? '?';
    return { actor: 'fabric', summary: `message ${item.act.messageRefId} re-correlated: ${item.act.live.resolution} with ${item.act.live.candidates.length} candidate(s) (correlation ${correlationId})` };
  },
  'opportunity.pursue': (db, item) => {
    const { latestTriage } = item.act;
    const failure = evaluateRules(item.rules, ['minScore', 'minCoverage', 'requireNoHardBlockers'], (key, value) => {
      if (key === 'minScore') {
        if (latestTriage.score === null) return 'rule minScore set but the triage carries no score';
        if (latestTriage.score < value) return `triage score ${latestTriage.score} < minScore ${value}`;
      }
      if (key === 'minCoverage') {
        if (latestTriage.coverage === null) return 'rule minCoverage set but the triage carries no coverage';
        if (latestTriage.coverage < value) return `triage coverage ${latestTriage.coverage} < minCoverage ${value}`;
      }
      if (key === 'requireNoHardBlockers' && value !== false && latestTriage.hardBlockers.length > 0) {
        return `triage lists hard blockers: ${latestTriage.hardBlockers.join(', ')}`;
      }
      return null;
    });
    if (failure) return { held: failure };
    if ((item.rules?.requireNoHardBlockers ?? true) !== false && latestTriage.hardBlockers.length > 0) {
      return { held: `triage lists hard blockers: ${latestTriage.hardBlockers.join(', ')}` };
    }
    const promoted = runOpportunityCommand(db, ['opportunity', 'promote'], { opportunityId: item.act.opportunityId });
    return {
      actor: policyActor(item),
      summary: `promoted to application ${promoted.application?.id ?? promoted.applicationId} (score ${latestTriage.score ?? 'n/a'})`
    };
  },

  'application.assessment-review': (db, item, services) => {
    if (typeof services.reviewAssessment !== 'function') {
      return { held: 'review-assessment executor not available in this process' };
    }
    const failure = evaluateRules(item.rules, [], () => null);
    if (failure) return { held: failure };
    const actor = policyActor(item);
    services.reviewAssessment(db, {
      applicationId: item.act.applicationId,
      decision: 'approved',
      decidedBy: actor,
      notes: `Fabric policy gate ${item.node} (${item.modeSource})`
    });
    return { actor, summary: `assessment #${item.act.assessmentId} approved` };
  },

  'application.uncertainty-accept': (db, item) => {
    const failure = evaluateRules(item.rules, [], () => null);
    if (failure) return { held: failure };
    if (!item.act.formStateSha256) return { held: 'no form-state sha available to pin the acceptance' };
    const actor = policyActor(item);
    acceptApplicationFormUncertainty(db, {
      applicationId: item.act.applicationId,
      acceptedBy: actor,
      reason: 'Fabric policy: no reviewable form exists for this surface; uncertainty accepted per gate configuration.',
      expectedFormStateSha256: item.act.formStateSha256,
      idempotencyKey: `fabric-application.uncertainty-accept-${item.act.applicationId}-v1`
    });
    return { actor, summary: 'form-coverage uncertainty accepted' };
  },

  'application.form-review': () => ({
    // There is deliberately no code executor for this gate: a captured form is
    // reviewed by a human (`jobtrack application-form review …`) or by a staffed
    // worker turn; a policy-mode configuration only records that the review is
    // owed. (The earlier text promised "Phase C automation"; Phase C shipped the
    // live agent workers on 2026-08-20 and left this gate human/worker-owned.)
    held: 'form-review has no code executor: a captured form is reviewed by a human or a staffed worker (jobtrack application-form review …); the gate holds until that review lands'
  }),

  'application.materials.render-lint': (db, item, services) => {
    const act = item.act;
    let renderId = act.renderId;
    if (act.needsRender) {
      if (typeof services.renderLatexMaterial !== 'function') {
        return { dispatch: 'renderer unavailable in this process — the cycle preflight owns Docker; render via the CLI' };
      }
      const created = createMaterialRender(db, {
        applicationId: act.applicationId,
        revisionId: act.revisionId,
        expectedContentSha256: act.contentSha256,
        renderedBy: 'fabric',
        idempotencyKey: `fabric-render-${act.revisionId}-v1`,
        renderMaterial: services.renderLatexMaterial
      });
      renderId = created.render.id;
    }
    const lint = recordMaterialLintReport(db, {
      applicationId: act.applicationId,
      renderId,
      lintedBy: 'fabric',
      idempotencyKey: `fabric-lint-${act.revisionId}-${renderId}-v1`
    });
    return {
      actor: 'fabric',
      summary: `render ${renderId} linted: ${lint.verdict}${lint.verdict === 'fail' ? ` (${lint.findings.filter((f) => f.severity === 'error').length} error(s) — the draft resurfaces for revision)` : ''}`
    };
  },

  'application.materials.review': (db, item) => {
    const act = item.act;
    const revision = require('./application-materials').getMaterialRevision(db, act.revisionId, act.applicationId);
    if (revision.material_kind === 'resume' && !isCompactResumeTemplate(revision.template_key)) {
      return { held: 'Automatic resume approval requires a compact resume template (resume.standard.v3 or v4) and independent editorial review; legacy approvals remain historical facts' };
    }
    const editorial = require('./application-resume-editorial').applicationResumeEditorialReadiness(db, revision, act.renderId);
    if (!editorial.ready) return { held: `Independent resume editorial review required: ${editorial.blockerCodes.join(', ')}` };
    const failure = evaluateRules(item.rules, ['maxWarnCount'], (key, value) => {
      if (key === 'maxWarnCount') {
        if (act.lintWarnCount === null) return 'rule maxWarnCount set but no lint warn count is available';
        if (act.lintWarnCount > value) return `lint warn count ${act.lintWarnCount} > maxWarnCount ${value}`;
      }
      return null;
    });
    if (failure) return { held: failure };
    const actor = policyActor(item);
    if (act.editorialOnly) return { actor, summary: `revision ${act.revisionId} editorial review is current; existing material approval preserved` };
    reviewMaterialRevision(db, {
      applicationId: act.applicationId,
      revisionId: act.revisionId,
      renderId: act.renderId ?? undefined,
      decision: 'approved',
      reviewedBy: actor,
      expectedReviewId: act.expectedReviewId,
      idempotencyKey: `fabric-review-${act.revisionId}-${act.expectedReviewId ? `after-${act.expectedReviewId}` : 'v1'}`
    });
    return { actor, summary: `revision ${act.revisionId} approved${act.renderId ? ` (render ${act.renderId})` : ''}` };
  },

  'application.materials.select': (db, item) => {
    const failure = evaluateRules(item.rules, [], () => null);
    if (failure) return { held: failure };
    const actor = policyActor(item);
    selectMaterialRevision(db, {
      applicationId: item.act.applicationId,
      revisionId: item.act.revisionId,
      selectedBy: actor,
      expectedSelectedRevisionId: item.act.expectedSelectedRevisionId,
      idempotencyKey: `fabric-select-${item.act.revisionId}-v1`
    });
    return { actor, summary: `revision ${item.act.revisionId} selected` };
  },

  'application.package': (db, item, services) => {
    if (typeof services.buildPackage !== 'function') {
      return { held: 'build-package executor not available in this process' };
    }
    services.buildPackage(db, {
      applicationId: item.act.applicationId,
      expectedReadinessSha256: item.act.readinessSha256,
      idempotencyKey: `fabric-application.package-${item.act.applicationId}-v1`,
      checklist: 'Fabric-built package; gate approvals are recorded in their lanes'
    });
    return { actor: 'fabric', summary: `package built and bound at readiness ${item.act.readinessSha256.slice(0, 12)}…` };
  },

  'application.submission.propose': (db, item) => {
    const act = item.act;
    if (!act.surfaceId) {
      return { dispatch: 'no surface URL on the application (job_url is empty) — propose needs the apply surface' };
    }
    const facts = readPackageSubmissionFacts(db, {
      applicationId: act.applicationId,
      packageId: act.packageId,
      expectedReadinessSha256: act.readinessSha256
    });
    if (facts.packageStatus !== 'ready') return { held: `package ${act.packageId} is ${facts.packageStatus}, not ready` };
    const proposed = proposeSubmission(db, {
      intentId: act.intentId,
      applicationId: act.applicationId,
      surfaceId: act.surfaceId,
      answers: facts.answers,
      documents: facts.documents
    });
    return { actor: 'fabric', summary: `intent ${act.intentId} proposed (digest ${proposed.intentDigest.slice(0, 12)}…)` };
  },

  'application.submission.approve': (db, item, services, now) => {
    const constraintFailure = approveConstraintFailure(item.constraints, item.act, now);
    if (constraintFailure) return { held: constraintFailure };
    const failure = evaluateRules(item.rules, [], () => null);
    if (failure) return { held: failure };
    if (!services.home) return { held: 'no store home available for approval signing keys in this process' };
    const actor = policyActor(item);
    approveSubmission(db, {
      intentId: item.act.intentId,
      expectedIntentDigest: item.act.intentDigest,
      approver: { kind: 'policy', id: actor },
      approvalId: `fabric-approval-${item.act.intentId}`,
      home: services.home
    });
    return { actor, summary: `intent ${item.act.intentId} approved by policy (surface ${item.act.surfaceId})` };
  },

  'application.verify-record': (db, item) => {
    const act = item.act;
    try {
      assertUploadsVerified(db, act.applicationId);
    } catch (error) {
      return { dispatch: `delivered files are not verified yet (${error.code || 'UPLOAD_NOT_VERIFIED'}) — the apply worker must run verify-uploads with the exact delivered bytes` };
    }
    const recorded = recordApplicationSubmission(db, {
      applicationId: act.applicationId,
      packageId: act.packageId,
      attemptId: act.attemptId,
      submittedBy: 'fabric',
      expectedReadinessSha256: act.readinessSha256,
      idempotencyKey: `fabric-record-${act.applicationId}-v1`
    });
    return { actor: 'fabric', summary: `submission recorded (event ${recorded.submission.id}, attempt ${act.attemptId})` };
  }
};

// ---------------------------------------------------------------------------
// item constructors + small helpers
// ---------------------------------------------------------------------------

function earliestWakeAt(subjects, clock = new Date()) {
  let earliest = null;
  const now = clock.getTime();
  for (const subject of subjects) {
    for (const item of subject.items ?? []) {
      const ms = item.wakeAt ? Date.parse(item.wakeAt) : NaN;
      if (Number.isFinite(ms) && ms > now && (earliest === null || ms < earliest)) earliest = ms;
    }
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}

function workItem(nodeId, { instance, reason, commands, idempotencyKey, act }) {
  const node = fabricNode(nodeId);
  return {
    node: node.id,
    title: node.title,
    kind: node.kind,
    executor: node.executor,
    ...(instance ? { instance } : {}),
    status: 'eligible',
    reason,
    commands,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(act ? { act } : {})
  };
}

function gateItem(nodeId, behavior, { instance, reason, commands, act }) {
  const node = fabricNode(nodeId);
  const parked = behavior.mode !== 'policy';
  return {
    node: node.id,
    title: node.title,
    kind: 'gate',
    ...(instance ? { instance } : {}),
    status: parked ? 'parked' : 'eligible',
    mode: behavior.mode,
    modeSource: behavior.source,
    ...(behavior.revisionId ? { revisionId: behavior.revisionId } : {}),
    ...(behavior.overrideId ? { overrideId: behavior.overrideId } : {}),
    ...(behavior.refusal ? { refusal: behavior.refusal } : {}),
    // Policy items carry what the tick needs to FIRE them: the gate's rules
    // and constraints (evaluated again at fire time, fail-closed) and the act.
    ...(behavior.mode === 'policy' ? { rules: behavior.rules, constraints: behavior.constraints } : {}),
    owner: behavior.mode === 'human' ? 'human' : behavior.mode === 'policy' ? 'policy' : 'operator',
    reason: behavior.mode === 'withhold' ? `${reason} — WITHHELD by configuration` : reason,
    commands,
    ...(act ? { act } : {})
  };
}

function readPlanMode(db, applicationId) {
  if (!tableExists(db, 'application_preparation_plans')) return null;
  const row = db.prepare(`
    SELECT m.slug FROM application_preparation_plans p
    JOIN application_preparation_modes m ON m.id=p.mode_id WHERE p.application_id=?
  `).get(applicationId);
  return row ? row.slug : null;
}

function readArtifactCounts(db, applicationId) {
  const counts = { posting: 0, research: 0 };
  for (const row of db.prepare(
    'SELECT kind, COUNT(*) AS n FROM application_artifacts WHERE application_id=? GROUP BY kind'
  ).all(applicationId)) {
    if (row.kind in counts) counts[row.kind] = row.n;
  }
  return counts;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function safeJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail('INVALID_ARGUMENT', `${label} is required`);
  return value.trim();
}

function positiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail('INVALID_ARGUMENT', `${label} must be a positive integer`);
  return parsed;
}

module.exports = {
  FABRIC_NEXT_SCHEMA,
  FABRIC_NODES,
  FABRIC_SCHEMA_VERSION,
  FABRIC_TICK_SCHEMA,
  FabricError,
  deriveFabricNext,
  listGateConfiguration,
  migrateFabric,
  resolveGateBehavior,
  runFabricTick,
  setGateOverride,
  setGatePolicy,
  _test: { deriveInterviews, deriveOffer, deriveSubmissionLane, nextFabricAttemptIdentity }
};
