'use strict';

const crypto = require('node:crypto');

const INTERVIEW_PREP_SCHEMA_VERSION = 2026071710;
const ANALYSIS_STATUSES = new Set(['draft', 'ready']);
const REVIEW_DECISIONS = new Set(['approved', 'rejected']);
const SECTION_KINDS = new Set([
  'role_focus', 'company_context', 'candidate_fit', 'skill_map', 'risk',
  'rehearsal_plan', 'questions_for_them', 'logistics', 'other'
]);
const QUESTION_KINDS = new Set(['expected', 'ask_them', 'rehearsal']);
const FOCUS_KINDS = new Set(['strength', 'gap', 'review']);
const STORY_RELATIONS = new Set(['example', 'backup', 'avoid']);
const ROUND_TYPES = [
  ['recruiter_screen', 'Recruiter screen', 'screen', 30, 10],
  ['hiring_manager', 'Hiring manager', 'screen', 45, 20],
  ['technical_screen', 'Technical screen', 'technical', 60, 30],
  ['coding', 'Coding', 'technical', 60, 40],
  ['system_design', 'System design', 'technical', 60, 50],
  ['behavioral', 'Behavioral', 'technical', 60, 60],
  ['take_home', 'Take-home exercise', 'technical', 120, 70],
  ['presentation', 'Presentation', 'onsite', 60, 80],
  ['panel', 'Panel / onsite loop', 'onsite', 240, 90],
  ['final', 'Final', 'final', 60, 100],
  ['other', 'Other', 'screen', 60, 999]
];

class InterviewPrepError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'InterviewPrepError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function migrateInterviewPrep(db) {
  const apply = () => {
    if (!tableExists(db, 'skills') || !tableExists(db, 'requirement_kinds')) {
      throw new InterviewPrepError('SCHEMA_DEPENDENCY_MISSING', 'Run the normalized catalog migration before interview-prep migration');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobtrack_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS interview_round_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9_]*'),
        label TEXT NOT NULL,
        compatibility_round TEXT NOT NULL CHECK (compatibility_round IN ('screen','technical','onsite','final')),
        default_duration_minutes INTEGER NOT NULL CHECK (default_duration_minutes BETWEEN 5 AND 1440),
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const insertRound = db.prepare(`
      INSERT INTO interview_round_types (slug, label, compatibility_round, default_duration_minutes, sort_order)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING
    `);
    for (const row of ROUND_TYPES) insertRound.run(...row);

    ensureColumn(db, 'interviews', 'round_type_id', 'INTEGER REFERENCES interview_round_types(id)');
    ensureColumn(db, 'interviews', 'sequence_no', 'INTEGER CHECK (sequence_no IS NULL OR sequence_no > 0)');
    ensureColumn(db, 'interviews', 'scheduled_start_utc', 'TEXT');
    ensureColumn(db, 'interviews', 'timezone', 'TEXT');
    ensureColumn(db, 'interviews', 'duration_minutes', 'INTEGER CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 1440)');
    ensureColumn(db, 'interviews', 'scheduling_status', "TEXT NOT NULL DEFAULT 'scheduled' CHECK (scheduling_status IN ('proposed','scheduled','rescheduled','cancelled','completed'))");
    ensureColumn(db, 'interviews', 'meeting_url', 'TEXT');
    ensureColumn(db, 'interviews', 'location_text', 'TEXT');
    ensureColumn(db, 'interviews', 'source_message_ref', 'TEXT');
    ensureColumn(db, 'interviews', 'source_calendar_ref', 'TEXT');
    ensureColumn(db, 'interviews', 'lock_version', 'INTEGER NOT NULL DEFAULT 0');

    if (columnExists(db, 'interviews', 'schedule_status')) {
      db.exec(`
        UPDATE interviews SET scheduling_status=CASE schedule_status
          WHEN 'cancelled' THEN 'cancelled' ELSE scheduling_status END
      `);
    }

    db.exec(`
      UPDATE interviews
      SET round_type_id = COALESCE(round_type_id, (
            SELECT id FROM interview_round_types
            WHERE compatibility_round = interviews.round
            ORDER BY CASE slug
              WHEN 'recruiter_screen' THEN 0
              WHEN 'technical_screen' THEN 0
              WHEN 'panel' THEN 0
              WHEN 'final' THEN 0
              ELSE 1 END, sort_order
            LIMIT 1
          )),
          sequence_no = COALESCE(sequence_no, (
            SELECT count(*) FROM interviews prior
            WHERE prior.application_id=interviews.application_id AND prior.id<=interviews.id
          )),
          scheduled_start_utc = COALESCE(scheduled_start_utc,
            CASE WHEN datetime(scheduled_at) IS NOT NULL
              THEN strftime('%Y-%m-%dT%H:%M:%fZ', scheduled_at) ELSE NULL END),
          timezone = COALESCE(timezone,
            CASE WHEN scheduled_at GLOB '*Z' THEN 'UTC' ELSE NULL END)
      WHERE round_type_id IS NULL OR sequence_no IS NULL OR scheduled_start_utc IS NULL OR timezone IS NULL;

      CREATE TABLE IF NOT EXISTS company_contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role_title TEXT,
        email TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(company_id, name, email)
      );

      CREATE TABLE IF NOT EXISTS interview_participants (
        interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
        contact_id INTEGER NOT NULL REFERENCES company_contacts(id) ON DELETE RESTRICT,
        participant_role TEXT NOT NULL DEFAULT 'interviewer' CHECK (participant_role IN ('interviewer','recruiter','coordinator','observer','other')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(interview_id, contact_id, participant_role)
      );

      CREATE TABLE IF NOT EXISTS interview_prep_analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE RESTRICT,
        version INTEGER NOT NULL CHECK (version > 0),
        status TEXT NOT NULL CHECK (status IN ('draft','ready','reviewed')),
        title TEXT NOT NULL,
        executive_summary TEXT,
        strategy TEXT,
        generated_by TEXT NOT NULL,
        generator_version TEXT,
        source_manifest_json TEXT NOT NULL CHECK (json_valid(source_manifest_json)),
        source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
        created_at TEXT NOT NULL,
        finalized_at TEXT,
        UNIQUE(interview_id, version)
      );

      CREATE TABLE IF NOT EXISTS interview_prep_current (
        interview_id INTEGER PRIMARY KEY REFERENCES interviews(id) ON DELETE CASCADE,
        analysis_id INTEGER NOT NULL UNIQUE REFERENCES interview_prep_analyses(id) ON DELETE CASCADE,
        selected_by TEXT NOT NULL,
        selected_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS interview_prep_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        analysis_id INTEGER NOT NULL REFERENCES interview_prep_analyses(id) ON DELETE RESTRICT,
        interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE RESTRICT,
        event_kind TEXT NOT NULL CHECK (event_kind IN ('created','selected','approved','rejected')),
        actor TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        CHECK (trim(actor) <> '')
      );

      CREATE TABLE IF NOT EXISTS interview_prep_operations (
        idempotency_key TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS interview_prep_sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        analysis_id INTEGER NOT NULL REFERENCES interview_prep_analyses(id) ON DELETE CASCADE,
        section_kind TEXT NOT NULL CHECK (section_kind IN ('role_focus','company_context','candidate_fit','skill_map','risk','rehearsal_plan','questions_for_them','logistics','other')),
        position INTEGER NOT NULL CHECK (position > 0),
        heading TEXT NOT NULL,
        content TEXT NOT NULL,
        UNIQUE(analysis_id, position)
      );

      CREATE TABLE IF NOT EXISTS interview_prep_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        analysis_id INTEGER NOT NULL REFERENCES interview_prep_analyses(id) ON DELETE CASCADE,
        question_kind TEXT NOT NULL CHECK (question_kind IN ('expected','ask_them','rehearsal')),
        position INTEGER NOT NULL CHECK (position > 0),
        prompt TEXT NOT NULL,
        suggested_answer TEXT,
        rationale TEXT,
        priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
        UNIQUE(analysis_id, question_kind, position)
      );

      CREATE TABLE IF NOT EXISTS interview_prep_skill_focus (
        analysis_id INTEGER NOT NULL REFERENCES interview_prep_analyses(id) ON DELETE CASCADE,
        skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
        requirement_kind_id INTEGER REFERENCES requirement_kinds(id) ON DELETE RESTRICT,
        focus_kind TEXT NOT NULL CHECK (focus_kind IN ('strength','gap','review')),
        priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
        notes TEXT,
        evidence_snapshot_id INTEGER REFERENCES opportunity_snapshots(id) ON DELETE RESTRICT,
        PRIMARY KEY(analysis_id, skill_id, focus_kind)
      );

      CREATE TABLE IF NOT EXISTS interview_prep_story_links (
        analysis_id INTEGER NOT NULL REFERENCES interview_prep_analyses(id) ON DELETE CASCADE,
        story_id INTEGER NOT NULL REFERENCES profile_stories(id) ON DELETE RESTRICT,
        revision_id INTEGER NOT NULL REFERENCES profile_story_revisions(id) ON DELETE RESTRICT,
        relation TEXT NOT NULL CHECK (relation IN ('example','backup','avoid')),
        permission_purpose TEXT NOT NULL,
        permission_decision TEXT NOT NULL CHECK (permission_decision = 'allow'),
        notes TEXT,
        PRIMARY KEY(analysis_id, story_id, revision_id, relation)
      );

      CREATE TABLE IF NOT EXISTS interview_prep_snapshot_evidence (
        analysis_id INTEGER NOT NULL REFERENCES interview_prep_analyses(id) ON DELETE CASCADE,
        snapshot_id INTEGER NOT NULL REFERENCES opportunity_snapshots(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL,
        PRIMARY KEY(analysis_id, snapshot_id)
      );

      CREATE TABLE IF NOT EXISTS interview_prep_artifact_evidence (
        analysis_id INTEGER NOT NULL REFERENCES interview_prep_analyses(id) ON DELETE CASCADE,
        artifact_id INTEGER NOT NULL REFERENCES application_artifacts(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL,
        PRIMARY KEY(analysis_id, artifact_id)
      );

      CREATE TABLE IF NOT EXISTS interview_prep_profile_evidence (
        analysis_id INTEGER NOT NULL REFERENCES interview_prep_analyses(id) ON DELETE CASCADE,
        profile_entry_id INTEGER NOT NULL REFERENCES profile_entries(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL,
        PRIMARY KEY(analysis_id, profile_entry_id)
      );

      CREATE INDEX IF NOT EXISTS idx_interviews_schedule_status
        ON interviews(scheduling_status, scheduled_at, outcome);
      CREATE INDEX IF NOT EXISTS idx_interview_prep_analyses_interview
        ON interview_prep_analyses(interview_id, version DESC);
      CREATE INDEX IF NOT EXISTS idx_interview_prep_events_analysis
        ON interview_prep_events(analysis_id, id DESC);

      CREATE TRIGGER IF NOT EXISTS trg_interview_prep_current_matches_interview_insert
      BEFORE INSERT ON interview_prep_current
      WHEN NOT EXISTS (
        SELECT 1 FROM interview_prep_analyses a
        WHERE a.id=NEW.analysis_id AND a.interview_id=NEW.interview_id
      ) BEGIN SELECT RAISE(ABORT, 'current prep analysis must belong to interview'); END;

      CREATE TRIGGER IF NOT EXISTS trg_interview_prep_current_matches_interview_update
      BEFORE UPDATE ON interview_prep_current
      WHEN NOT EXISTS (
        SELECT 1 FROM interview_prep_analyses a
        WHERE a.id=NEW.analysis_id AND a.interview_id=NEW.interview_id
      ) BEGIN SELECT RAISE(ABORT, 'current prep analysis must belong to interview'); END;

      CREATE TRIGGER IF NOT EXISTS trg_interview_prep_story_revision_matches
      BEFORE INSERT ON interview_prep_story_links
      WHEN NOT EXISTS (
        SELECT 1 FROM profile_story_revisions r
        WHERE r.id=NEW.revision_id AND r.story_id=NEW.story_id
      ) BEGIN SELECT RAISE(ABORT, 'prep story revision must belong to story'); END;
    `);

    for (const table of [
      'interview_prep_analyses', 'interview_prep_sections', 'interview_prep_questions',
      'interview_prep_skill_focus', 'interview_prep_story_links',
      'interview_prep_snapshot_evidence', 'interview_prep_artifact_evidence',
      'interview_prep_profile_evidence', 'interview_prep_events',
      'interview_prep_operations'
    ]) createImmutableTriggers(db, table);

    const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(INTERVIEW_PREP_SCHEMA_VERSION);
    if (migration && migration.name !== 'versioned_interview_preparation') {
      throw new InterviewPrepError('MIGRATION_CONFLICT', `Schema version ${INTERVIEW_PREP_SCHEMA_VERSION} is already named ${migration.name}`);
    }
    if (!migration) db.prepare(`
      INSERT INTO jobtrack_schema_migrations (version, name)
      VALUES (?, 'versioned_interview_preparation')
    `).run(INTERVIEW_PREP_SCHEMA_VERSION);
  };
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
}

function createScheduledInterview(db, input) {
  const applicationId = positiveId(input.applicationId, 'application id');
  if (!db.prepare('SELECT 1 FROM applications WHERE id=?').get(applicationId)) {
    throw new InterviewPrepError('NOT_FOUND', `Application not found: ${applicationId}`);
  }
  const roundType = resolveRoundType(db, input.roundType || input.round);
  const scheduledAt = strictIsoDateTime(input.scheduledAt, 'scheduledAt');
  const timezone = timezoneValue(input.timezone, scheduledAt);
  const format = enumeration(input.format, new Set(['phone', 'video', 'onsite']), 'format');
  const outcome = enumeration(input.outcome || 'pending', new Set(['pending', 'passed', 'failed']), 'outcome');
  const schedulingStatus = enumeration(input.schedulingStatus || 'scheduled', new Set(['proposed', 'scheduled', 'rescheduled', 'cancelled', 'completed']), 'schedulingStatus');
  const sequenceNo = db.prepare('SELECT count(*)+1 AS value FROM interviews WHERE application_id=?').get(applicationId).value;
  const durationMinutes = input.durationMinutes === undefined || input.durationMinutes === null
    ? roundType.default_duration_minutes
    : integer(input.durationMinutes, 'durationMinutes', 5, 1440);
  const meetingUrl = optionalUrl(input.meetingUrl, 'meetingUrl');
  const inserted = db.prepare(`
    INSERT INTO interviews (
      application_id, round, scheduled_at, format, interviewer, outcome, notes,
      round_type_id, sequence_no, scheduled_start_utc, timezone, duration_minutes,
      scheduling_status, meeting_url, location_text, source_message_ref,
      source_calendar_ref, lock_version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
  `).run(
    applicationId, roundType.compatibility_round, scheduledAt, format,
    optionalString(input.interviewer, 'interviewer', 1000), outcome,
    optionalString(input.notes, 'notes', 50_000), roundType.id, sequenceNo,
    new Date(scheduledAt).toISOString(), timezone, durationMinutes, schedulingStatus,
    meetingUrl, optionalString(input.locationText, 'locationText', 2000),
    optionalString(input.sourceMessageRef, 'sourceMessageRef', 1000),
    optionalString(input.sourceCalendarRef, 'sourceCalendarRef', 1000)
  );
  return db.prepare('SELECT * FROM interviews WHERE id=?').get(inserted.lastInsertRowid);
}

function updateScheduledInterview(db, interviewId, input = {}) {
  interviewId = positiveId(interviewId, 'interview id');
  const current = db.prepare('SELECT * FROM interviews WHERE id=?').get(interviewId);
  if (!current) throw new InterviewPrepError('NOT_FOUND', `Interview not found: ${interviewId}`);
  const expectedLockVersion = input.expectedLockVersion === undefined
    ? current.lock_version
    : integer(input.expectedLockVersion, 'expectedLockVersion', 0, Number.MAX_SAFE_INTEGER);
  const set = [];
  const params = { interviewId, expectedLockVersion };
  if (input.round !== undefined || input.roundType !== undefined) {
    const roundType = resolveRoundType(db, input.roundType || input.round);
    set.push('round=@round', 'round_type_id=@roundTypeId');
    params.round = roundType.compatibility_round;
    params.roundTypeId = roundType.id;
  }
  if (input.scheduledAt !== undefined) {
    params.scheduledAt = strictIsoDateTime(input.scheduledAt, 'scheduledAt');
    params.scheduledStartUtc = new Date(params.scheduledAt).toISOString();
    params.timezone = timezoneValue(input.timezone === undefined ? current.timezone : input.timezone, params.scheduledAt);
    set.push('scheduled_at=@scheduledAt', 'scheduled_start_utc=@scheduledStartUtc', 'timezone=@timezone');
  } else if (input.timezone !== undefined) {
    params.timezone = timezoneValue(input.timezone, current.scheduled_at);
    set.push('timezone=@timezone');
  }
  const scalarFields = [
    ['format', 'format', (value) => enumeration(value, new Set(['phone', 'video', 'onsite']), 'format')],
    ['interviewer', 'interviewer', (value) => optionalString(value, 'interviewer', 1000)],
    ['outcome', 'outcome', (value) => enumeration(value, new Set(['pending', 'passed', 'failed']), 'outcome')],
    ['notes', 'notes', (value) => optionalString(value, 'notes', 50_000)],
    ['durationMinutes', 'duration_minutes', (value) => integer(value, 'durationMinutes', 5, 1440)],
    ['schedulingStatus', 'scheduling_status', (value) => enumeration(value, new Set(['proposed', 'scheduled', 'rescheduled', 'cancelled', 'completed']), 'schedulingStatus')],
    ['meetingUrl', 'meeting_url', (value) => optionalUrl(value, 'meetingUrl')],
    ['locationText', 'location_text', (value) => optionalString(value, 'locationText', 2000)],
    ['sourceMessageRef', 'source_message_ref', (value) => optionalString(value, 'sourceMessageRef', 1000)],
    ['sourceCalendarRef', 'source_calendar_ref', (value) => optionalString(value, 'sourceCalendarRef', 1000)]
  ];
  for (const [field, column, normalize] of scalarFields) {
    if (input[field] === undefined) continue;
    params[field] = normalize(input[field]);
    set.push(`${column}=@${field}`);
  }
  if (!set.length) throw new InterviewPrepError('VALIDATION_ERROR', 'Provide at least one interview field to update');
  set.push("updated_at=datetime('now')", 'lock_version=lock_version+1');
  const result = db.prepare(`
    UPDATE interviews SET ${set.join(', ')}
    WHERE id=@interviewId AND lock_version=@expectedLockVersion
  `).run(params);
  if (result.changes !== 1) throw new InterviewPrepError('STALE_INTERVIEW', `Interview ${interviewId} changed concurrently`);
  return db.prepare('SELECT * FROM interviews WHERE id=?').get(interviewId);
}

function resolveRoundType(db, value) {
  const token = boundedString(value, 'roundType', 1, 100).normalize('NFKC').toLowerCase().replace(/[\s-]+/g, '_');
  const exact = db.prepare('SELECT * FROM interview_round_types WHERE slug=?').get(token);
  if (exact) return exact;
  const compatible = db.prepare(`
    SELECT * FROM interview_round_types WHERE compatibility_round=?
    ORDER BY CASE slug
      WHEN 'recruiter_screen' THEN 0 WHEN 'technical_screen' THEN 0
      WHEN 'panel' THEN 0 WHEN 'final' THEN 0 ELSE 1 END, sort_order LIMIT 1
  `).get(token);
  if (!compatible) throw new InterviewPrepError('INVALID_ROUND_TYPE', `Unknown interview round type: ${value}`);
  return compatible;
}

function listInterviewPrepQueue(db, filters = {}) {
  const where = ["i.outcome='pending'", "COALESCE(i.scheduling_status,'scheduled') <> 'cancelled'"];
  const params = {};
  if (filters.before) { where.push('datetime(i.scheduled_at) <= datetime(@before)'); params.before = isoDateTime(filters.before, 'before'); }
  if (filters.after) { where.push('datetime(i.scheduled_at) >= datetime(@after)'); params.after = isoDateTime(filters.after, 'after'); }
  return db.prepare(`
    SELECT i.id AS interview_id, i.application_id, i.round, i.scheduled_at, i.format,
      i.interviewer, i.scheduling_status, i.timezone, i.duration_minutes,
      a.status AS application_status, a.workflow_stage,
      COALESCE(c.canonical_name, a.company) AS company,
      COALESCE(jo.canonical_title, a.role) AS role,
      current_analysis.id AS current_analysis_id,
      current_analysis.version AS current_analysis_version,
      current_analysis.status AS current_analysis_status,
      current_analysis.source_digest
    FROM interviews i
    JOIN applications a ON a.id=i.application_id
    LEFT JOIN job_openings jo ON jo.id=a.job_opening_id
    LEFT JOIN companies c ON c.id=jo.company_id
    LEFT JOIN interview_prep_current ipc ON ipc.interview_id=i.id
    LEFT JOIN interview_prep_analyses current_analysis ON current_analysis.id=ipc.analysis_id
    WHERE ${where.join(' AND ')}
    ORDER BY datetime(i.scheduled_at), i.id
  `).all(params).map((row) => ({
    ...row,
    prep_stale: row.current_analysis_id ? isInterviewPrepAnalysisStale(db, row.current_analysis_id) : null
  }));
}

function buildInterviewPrepContext(db, interviewId) {
  interviewId = positiveId(interviewId, 'interview id');
  const core = db.prepare(`
    SELECT i.*, irt.slug AS round_type, irt.label AS round_type_label,
      a.status AS application_status, a.workflow_stage, a.applied_date,
      a.job_opening_id AS opening_id, COALESCE(c.canonical_name, a.company) AS company,
      COALESCE(jo.canonical_title, a.role) AS role,
      jo.company_id
    FROM interviews i
    JOIN applications a ON a.id=i.application_id
    LEFT JOIN interview_round_types irt ON irt.id=i.round_type_id
    LEFT JOIN job_openings jo ON jo.id=a.job_opening_id
    LEFT JOIN companies c ON c.id=jo.company_id
    WHERE i.id=?
  `).get(interviewId);
  if (!core) throw new InterviewPrepError('NOT_FOUND', `Interview not found: ${interviewId}`);

  const openingId = core.opening_id;
  const applicationId = core.application_id;
  const postings = openingId ? db.prepare(`
    SELECT jp.id, jp.canonical_url, jp.external_id AS external_posting_id, jp.state,
      pp.slug AS platform, pv.venue_key AS venue,
      ap.relation AS application_relation, ap.is_primary
    FROM job_postings jp
    JOIN posting_venues pv ON pv.id=jp.posting_venue_id
    JOIN posting_platforms pp ON pp.id=pv.posting_platform_id
    LEFT JOIN application_postings ap ON ap.job_posting_id=jp.id AND ap.application_id=?
    WHERE jp.job_opening_id=? ORDER BY ap.is_primary DESC, jp.id
  `).all(applicationId, openingId) : [];
  const roleTypes = openingId ? db.prepare(`
    SELECT rt.id, rt.slug, rt.label, ort.is_primary, ort.confidence, ort.source
    FROM opening_role_types ort JOIN role_types rt ON rt.id=ort.role_type_id
    WHERE ort.job_opening_id=? ORDER BY ort.is_primary DESC, rt.label
  `).all(openingId) : [];
  const seniority = openingId ? db.prepare(`
    SELECT sl.id, sl.slug, sl.label, sl.sort_rank AS rank, sl.career_track,
      osl.is_primary, osl.confidence, osl.source
    FROM opening_seniority_levels osl JOIN seniority_levels sl ON sl.id=osl.seniority_level_id
    WHERE osl.job_opening_id=? ORDER BY osl.is_primary DESC, sl.sort_rank
  `).all(openingId) : [];
  const skillRequirements = openingId ? db.prepare(`
    SELECT DISTINCT s.id AS skill_id, s.canonical_name, rk.slug AS requirement_kind,
      psr.raw_phrase, psr.minimum_years AS min_years, psr.confidence,
      psr.opportunity_snapshot_id AS snapshot_id,
      CASE WHEN EXISTS (
        SELECT 1 FROM profile_skill_catalog_links link WHERE link.skill_id=s.id
      ) THEN 1 ELSE 0 END AS candidate_has_skill,
      CASE WHEN EXISTS (
        SELECT 1
        FROM profile_skill_catalog_links link
        JOIN profile_skills profile_skill ON profile_skill.id=link.profile_skill_id
        JOIN profile_entries entry ON entry.id=profile_skill.profile_entry_id
        WHERE link.skill_id=s.id AND entry.confidence='high'
          AND (trim(COALESCE(entry.evidence,''))<>''
            OR trim(COALESCE(entry.source_url,''))<>''
            OR trim(COALESCE(entry.attachment_path,''))<>'')
      ) THEN 1 ELSE 0 END AS candidate_has_grounded_skill
    FROM job_postings jp
    JOIN posting_skill_requirements psr ON psr.job_posting_id=jp.id
    JOIN skills s ON s.id=psr.skill_id
    JOIN requirement_kinds rk ON rk.id=psr.requirement_kind_id
    WHERE jp.job_opening_id=?
    ORDER BY rk.sort_rank DESC, lower(s.canonical_name), psr.opportunity_snapshot_id DESC
  `).all(openingId) : [];
  const participants = db.prepare(`
    SELECT cc.id AS contact_id, cc.name, cc.role_title, ip.participant_role
    FROM interview_participants ip JOIN company_contacts cc ON cc.id=ip.contact_id
    WHERE ip.interview_id=? ORDER BY ip.participant_role, cc.name
  `).all(interviewId);
  const artifacts = db.prepare(`
    SELECT id, kind, title, source_url, source_name, citation, captured_at
    FROM application_artifacts WHERE application_id=?
    ORDER BY datetime(captured_at) DESC, id DESC
  `).all(applicationId);
  const allowedStories = tableExists(db, 'profile_stories') ? db.prepare(`
    SELECT ps.id AS story_id, pr.id AS revision_id, pr.title, pr.one_line_summary,
      COALESCE(perm.decision, ps.default_use_decision) AS permission_decision
    FROM profile_stories ps
    JOIN profile_story_revisions pr ON pr.story_id=ps.id AND pr.is_current=1
    LEFT JOIN profile_story_permissions perm
      ON perm.story_id=ps.id AND perm.purpose='interview'
    WHERE COALESCE(perm.decision, ps.default_use_decision)='allow'
      AND (perm.expires_at IS NULL OR datetime(perm.expires_at) > datetime('now'))
    ORDER BY pr.title, ps.id
  `).all() : [];
  return {
    schemaVersion: 'interview-prep-context.v1',
    interview: stripUndefined(core),
    postings,
    roleTypes,
    seniority,
    skillRequirements,
    participants,
    artifacts,
    allowedStories
  };
}

function createInterviewPrepAnalysis(db, input, context = {}) {
  const normalized = normalizeAnalysisInput(input);
  const idempotencyKey = idempotencyKeyValue(context.idempotencyKey, 'idempotencyKey');
  const request = { analysis: normalized };
  const result = idempotentInterviewOperation(db, 'create-analysis', idempotencyKey, request, () => {
    const sourceManifest = buildAnalysisSourceManifest(db, normalized);
    const sourceDigest = prepSourceDigest(sourceManifest);
    const createdAt = strictIsoDateTime(context.now || new Date().toISOString(), 'now');
    const nextVersion = db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM interview_prep_analyses WHERE interview_id=?').get(normalized.interviewId).version;
    const analysis = db.prepare(`
      INSERT INTO interview_prep_analyses (
        interview_id, version, status, title, executive_summary, strategy,
        generated_by, generator_version, source_manifest_json, source_digest, created_at, finalized_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.interviewId, nextVersion, normalized.status, normalized.title,
      normalized.executiveSummary, normalized.strategy, normalized.generatedBy,
      normalized.generatorVersion, stableJson(sourceManifest), sourceDigest, createdAt,
      normalized.status === 'draft' ? null : createdAt
    );
    const analysisId = Number(analysis.lastInsertRowid);
    const insertSection = db.prepare(`
      INSERT INTO interview_prep_sections (analysis_id, section_kind, position, heading, content)
      VALUES (?, ?, ?, ?, ?)
    `);
    normalized.sections.forEach((section, index) => insertSection.run(analysisId, section.kind, index + 1, section.heading, section.content));
    const insertQuestion = db.prepare(`
      INSERT INTO interview_prep_questions (analysis_id, question_kind, position, prompt, suggested_answer, rationale, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const questionPositions = new Map();
    for (const question of normalized.questions) {
      const position = (questionPositions.get(question.kind) || 0) + 1;
      questionPositions.set(question.kind, position);
      insertQuestion.run(analysisId, question.kind, position, question.prompt, question.suggestedAnswer, question.rationale, question.priority);
    }
    insertSkillFocus(db, analysisId, normalized.interviewId, normalized.skillFocus);
    insertStoryLinks(db, analysisId, normalized.storyLinks);
    insertEvidence(db, analysisId, normalized.interviewId, normalized.evidence);
    insertPrepEvent(db, analysisId, normalized.interviewId, 'created', normalized.generatedBy, null, createdAt);
    const current = db.prepare('SELECT analysis_id FROM interview_prep_current WHERE interview_id=?').get(normalized.interviewId);
    let selected = false;
    if (!current) {
      const actor = 'system:first-analysis';
      db.prepare(`
        INSERT INTO interview_prep_current (interview_id, analysis_id, selected_by, selected_at)
        VALUES (?, ?, ?, ?)
      `).run(normalized.interviewId, analysisId, actor, createdAt);
      insertPrepEvent(db, analysisId, normalized.interviewId, 'selected', actor, 'Initial prep analysis', createdAt);
      selected = true;
    }
    return { analysisId, version: nextVersion, selected };
  });
  return getInterviewPrepAnalysis(db, result.analysisId);
}

function reviewInterviewPrepAnalysis(db, input, context = {}) {
  const analysisId = positiveId(input.analysisId, 'analysis id');
  const decision = enumeration(input.decision, REVIEW_DECISIONS, 'decision');
  const reviewedBy = boundedString(input.reviewedBy, 'reviewedBy', 1, 200);
  const notes = optionalString(input.notes, 'notes', 10_000);
  const idempotencyKey = idempotencyKeyValue(context.idempotencyKey, 'idempotencyKey');
  const result = idempotentInterviewOperation(db, 'review-analysis', idempotencyKey, {
    analysisId, decision, reviewedBy, notes
  }, () => {
    const analysis = db.prepare('SELECT id, interview_id FROM interview_prep_analyses WHERE id=?').get(analysisId);
    if (!analysis) throw new InterviewPrepError('NOT_FOUND', `Interview-prep analysis not found: ${analysisId}`);
    const createdAt = strictIsoDateTime(context.now || new Date().toISOString(), 'now');
    insertPrepEvent(db, analysisId, analysis.interview_id, decision, reviewedBy, notes, createdAt);
    return { analysisId, interviewId: analysis.interview_id, decision };
  });
  return { ...result, prep: getInterviewPrepAnalysis(db, analysisId) };
}

function selectCurrentInterviewPrep(db, input, context = {}) {
  const analysisId = positiveId(input.analysisId, 'analysis id');
  const selectedBy = boundedString(input.selectedBy, 'selectedBy', 1, 200);
  const expectedCurrentAnalysisId = nullableExpectedId(input.expectedCurrentAnalysisId, 'expectedCurrentAnalysisId');
  const idempotencyKey = idempotencyKeyValue(context.idempotencyKey, 'idempotencyKey');
  const result = idempotentInterviewOperation(db, 'select-analysis', idempotencyKey, {
    analysisId, selectedBy, expectedCurrentAnalysisId
  }, () => {
    const analysis = db.prepare('SELECT id, interview_id FROM interview_prep_analyses WHERE id=?').get(analysisId);
    if (!analysis) throw new InterviewPrepError('NOT_FOUND', `Interview-prep analysis not found: ${analysisId}`);
    const current = db.prepare('SELECT analysis_id FROM interview_prep_current WHERE interview_id=?').get(analysis.interview_id);
    const currentId = current ? current.analysis_id : null;
    if (currentId !== expectedCurrentAnalysisId) {
      throw new InterviewPrepError('STALE_CURRENT', `Expected current analysis ${expectedCurrentAnalysisId ?? 'none'}, found ${currentId ?? 'none'}`);
    }
    const latestReview = latestPrepReview(db, analysisId);
    if (latestReview?.event_kind === 'rejected') {
      throw new InterviewPrepError('REJECTED_ANALYSIS', `Interview-prep analysis ${analysisId} is rejected`);
    }
    const selectedAt = strictIsoDateTime(context.now || new Date().toISOString(), 'now');
    db.prepare(`
      INSERT INTO interview_prep_current (interview_id, analysis_id, selected_by, selected_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(interview_id) DO UPDATE SET
        analysis_id=excluded.analysis_id, selected_by=excluded.selected_by, selected_at=excluded.selected_at
    `).run(analysis.interview_id, analysisId, selectedBy, selectedAt);
    insertPrepEvent(db, analysisId, analysis.interview_id, 'selected', selectedBy, null, selectedAt);
    return { analysisId, interviewId: analysis.interview_id, previousAnalysisId: currentId };
  });
  return { ...result, prep: getInterviewPrepAnalysis(db, analysisId) };
}

function generateDeterministicPrep(db, interviewId, context = {}) {
  const source = buildInterviewPrepContext(db, interviewId);
  const requirementPriority = new Map([['required', 3], ['preferred', 2], ['mentioned', 1]]);
  const dedupedRequirements = new Map();
  for (const row of source.skillRequirements) {
    const current = dedupedRequirements.get(row.skill_id);
    if (!current || (requirementPriority.get(row.requirement_kind) || 0) > (requirementPriority.get(current.requirement_kind) || 0)) {
      dedupedRequirements.set(row.skill_id, row);
    }
  }
  const requirements = [...dedupedRequirements.values()];
  const required = requirements.filter((row) => row.requirement_kind === 'required');
  const preferred = requirements.filter((row) => row.requirement_kind === 'preferred');
  const strengths = required.filter((row) => row.candidate_has_grounded_skill);
  const linkedButUngrounded = required.filter((row) => row.candidate_has_skill && !row.candidate_has_grounded_skill);
  const gaps = required.filter((row) => !row.candidate_has_skill);
  const roleLabels = source.roleTypes.map((row) => row.label);
  const seniorityLabels = source.seniority.map((row) => row.label);
  const list = (items) => items.length ? items.join(', ') : 'not yet classified';
  const sections = [
    {
      kind: 'role_focus', heading: 'Role focus',
      content: `${source.interview.company} — ${source.interview.role}. Role types: ${list(roleLabels)}. Seniority: ${list(seniorityLabels)}.`
    },
    {
      kind: 'skill_map', heading: 'Evidence-backed skill map',
      content: `Required skills with high-confidence linked evidence: ${list(strengths.map((row) => row.canonical_name))}. Linked skills that still need concrete evidence: ${list(linkedButUngrounded.map((row) => row.canonical_name))}. Required skills without a canonical profile-skill relation: ${list(gaps.map((row) => row.canonical_name))}. Preferred skills: ${list(preferred.map((row) => row.canonical_name))}. A profile relation alone is a lead, not proof of proficiency.`
    },
    {
      kind: 'rehearsal_plan', heading: 'Rehearsal plan',
      content: 'Prepare concise examples for the highest-priority required skills, rehearse tradeoffs and failure recovery, and keep every claim grounded in linked profile evidence.'
    },
    {
      kind: 'logistics', heading: 'Logistics check',
      content: `Confirm ${source.interview.format || 'format'}, ${source.interview.scheduled_at}, timezone ${source.interview.timezone || 'not recorded'}, duration ${source.interview.duration_minutes || 'not recorded'} minutes, participants, and meeting location before the interview.`
    }
  ];
  const questions = required.slice(0, 8).map((row) => ({
    kind: 'expected',
    prompt: `Be ready to explain recent work using ${row.canonical_name}, including the constraints, tradeoffs, outcome, and what you would change.`,
    rationale: `The posting marks ${row.canonical_name} as required.`,
    priority: row.candidate_has_skill ? 4 : 5
  }));
  questions.push({
    kind: 'ask_them',
    prompt: 'What would excellent performance in this role look like after 30, 60, and 90 days?',
    rationale: 'Clarifies expectations and exposes the real near-term problem set.',
    priority: 4
  });
  const skillFocus = requirements.map((row) => ({
    skillId: row.skill_id,
    requirementKind: row.requirement_kind,
    focusKind: row.candidate_has_grounded_skill ? 'strength' : row.candidate_has_skill ? 'review' : row.requirement_kind === 'required' ? 'gap' : 'review',
    priority: row.requirement_kind === 'required' ? 5 : row.requirement_kind === 'preferred' ? 3 : 2,
    notes: row.candidate_has_grounded_skill
      ? 'High-confidence profile skill relation has linked evidence; verify the exact claim before use.'
      : row.candidate_has_skill
        ? 'Profile skill relation exists but lacks high-confidence linked evidence; supply proof before treating it as a strength.'
        : 'No canonical profile-skill link yet; verify before claiming.',
    evidenceSnapshotId: row.snapshot_id
  }));
  return createInterviewPrepAnalysis(db, {
    interviewId,
    status: 'draft',
    title: `${source.interview.company} — ${source.interview.role} interview prep`,
    executiveSummary: 'Deterministic evidence map. Add an agent- or human-authored revision for deeper analysis; do not treat missing links as missing ability.',
    strategy: 'Prioritize required-skill evidence, clarify unlinked gaps, rehearse tradeoffs, and verify logistics.',
    generatedBy: context.generatedBy || 'jobtrack-deterministic',
    generatorVersion: 'interview-prep-generator.v1',
    sections,
    questions,
    skillFocus,
    storyLinks: [],
    evidence: {
      snapshots: [...new Set(source.skillRequirements.map((row) => row.snapshot_id).filter(Boolean))].map((id) => ({ id, reason: 'Source for a role skill requirement' })),
      artifacts: [],
      profiles: []
    }
  }, context);
}

function getInterviewPrepAnalysis(db, analysisId) {
  analysisId = positiveId(analysisId, 'analysis id');
  const analysis = db.prepare(`
    SELECT a.*, ipc.analysis_id=a.id AS is_current
    FROM interview_prep_analyses a
    LEFT JOIN interview_prep_current ipc ON ipc.interview_id=a.interview_id
    WHERE a.id=?
  `).get(analysisId);
  if (!analysis) throw new InterviewPrepError('NOT_FOUND', `Interview-prep analysis not found: ${analysisId}`);
  const sourceContext = buildInterviewPrepContext(db, analysis.interview_id);
  const review = latestPrepReview(db, analysisId);
  return {
    analysis: {
      ...analysis,
      source_manifest: JSON.parse(analysis.source_manifest_json),
      is_current: Boolean(analysis.is_current),
      review_status: review ? review.event_kind : 'unreviewed',
      reviewed_by: review ? review.actor : null,
      reviewed_at: review ? review.created_at : null,
      is_stale: isInterviewPrepAnalysisStale(db, analysisId)
    },
    context: sourceContext,
    sections: db.prepare('SELECT * FROM interview_prep_sections WHERE analysis_id=? ORDER BY position').all(analysisId),
    questions: db.prepare('SELECT * FROM interview_prep_questions WHERE analysis_id=? ORDER BY question_kind, position').all(analysisId),
    skillFocus: db.prepare(`
      SELECT f.*, s.canonical_name, rk.slug AS requirement_kind
      FROM interview_prep_skill_focus f JOIN skills s ON s.id=f.skill_id
      LEFT JOIN requirement_kinds rk ON rk.id=f.requirement_kind_id
      WHERE f.analysis_id=? ORDER BY f.priority DESC, lower(s.canonical_name)
    `).all(analysisId),
    storyLinks: db.prepare(`
      SELECT l.*, r.title, r.one_line_summary
      FROM interview_prep_story_links l JOIN profile_story_revisions r ON r.id=l.revision_id
      WHERE l.analysis_id=? ORDER BY l.relation, r.title
    `).all(analysisId),
    evidence: {
      snapshots: db.prepare('SELECT * FROM interview_prep_snapshot_evidence WHERE analysis_id=? ORDER BY snapshot_id').all(analysisId),
      artifacts: db.prepare('SELECT * FROM interview_prep_artifact_evidence WHERE analysis_id=? ORDER BY artifact_id').all(analysisId),
      profiles: db.prepare('SELECT * FROM interview_prep_profile_evidence WHERE analysis_id=? ORDER BY profile_entry_id').all(analysisId)
    },
    events: db.prepare('SELECT * FROM interview_prep_events WHERE analysis_id=? ORDER BY id').all(analysisId)
  };
}

function getCurrentInterviewPrep(db, interviewId) {
  interviewId = positiveId(interviewId, 'interview id');
  const row = db.prepare('SELECT analysis_id FROM interview_prep_current WHERE interview_id=?').get(interviewId);
  return row ? getInterviewPrepAnalysis(db, row.analysis_id) : { analysis: null, context: buildInterviewPrepContext(db, interviewId), sections: [], questions: [], skillFocus: [], storyLinks: [], evidence: { snapshots: [], artifacts: [], profiles: [] }, events: [] };
}

function insertSkillFocus(db, analysisId, interviewId, items) {
  const target = interviewTarget(db, interviewId);
  const insert = db.prepare(`
    INSERT INTO interview_prep_skill_focus (
      analysis_id, skill_id, requirement_kind_id, focus_kind, priority, notes, evidence_snapshot_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of items) {
    const skill = db.prepare('SELECT id FROM skills WHERE id=?').get(item.skillId);
    if (!skill) throw new InterviewPrepError('INVALID_SKILL', `Unknown skill: ${item.skillId}`);
    let requirementKindId = null;
    if (item.requirementKind) {
      const kind = db.prepare('SELECT id FROM requirement_kinds WHERE slug=?').get(item.requirementKind);
      if (!kind) throw new InterviewPrepError('INVALID_REQUIREMENT_KIND', `Unknown requirement kind: ${item.requirementKind}`);
      requirementKindId = kind.id;
    }
    const requirement = db.prepare(`
      SELECT 1
      FROM posting_skill_requirements psr
      JOIN job_postings jp ON jp.id=psr.job_posting_id
      WHERE jp.job_opening_id=? AND psr.skill_id=?
        AND (? IS NULL OR psr.requirement_kind_id=?)
      LIMIT 1
    `).get(target.openingId, item.skillId, requirementKindId, requirementKindId);
    const profileRelation = db.prepare(`
      SELECT 1 FROM profile_skill_catalog_links WHERE skill_id=? LIMIT 1
    `).get(item.skillId);
    if ((requirementKindId && !requirement) || (!requirement && !profileRelation)) {
      throw new InterviewPrepError(
        'SKILL_FOCUS_MISMATCH',
        `Skill ${item.skillId}${item.requirementKind ? ` (${item.requirementKind})` : ''} is not linked to this opening or the profile catalog`
      );
    }
    if (item.evidenceSnapshotId) {
      const match = db.prepare(`
        SELECT 1
        FROM posting_skill_requirements psr
        JOIN opportunity_snapshots os ON os.id=psr.opportunity_snapshot_id
        JOIN job_postings jp ON jp.id=psr.job_posting_id AND jp.id=os.job_posting_id
        WHERE psr.opportunity_snapshot_id=? AND psr.skill_id=?
          AND jp.job_opening_id=?
          AND (? IS NULL OR psr.requirement_kind_id=?)
      `).get(item.evidenceSnapshotId, item.skillId, target.openingId, requirementKindId, requirementKindId);
      if (!match) {
        throw new InterviewPrepError('EVIDENCE_MISMATCH', `Snapshot ${item.evidenceSnapshotId} is not evidence for skill ${item.skillId} on this opening`);
      }
    }
    insert.run(analysisId, item.skillId, requirementKindId, item.focusKind, item.priority, item.notes, item.evidenceSnapshotId);
  }
}

function insertStoryLinks(db, analysisId, items) {
  const insert = db.prepare(`
    INSERT INTO interview_prep_story_links (
      analysis_id, story_id, revision_id, relation, permission_purpose, permission_decision, notes
      ) VALUES (?, ?, ?, ?, 'interview', 'allow', ?)
  `);
  for (const item of items) {
    const allowed = db.prepare(`
      SELECT pr.id
      FROM profile_stories ps JOIN profile_story_revisions pr ON pr.id=? AND pr.story_id=ps.id
      LEFT JOIN profile_story_permissions p ON p.story_id=ps.id AND p.purpose='interview'
      WHERE ps.id=? AND COALESCE(p.decision, ps.default_use_decision)='allow'
        AND (p.expires_at IS NULL OR datetime(p.expires_at) > datetime('now'))
    `).get(item.revisionId, item.storyId);
    if (!allowed) throw new InterviewPrepError('STORY_PERMISSION_REQUIRED', `Story ${item.storyId} revision ${item.revisionId} is not allowed for interview use`);
    insert.run(analysisId, item.storyId, item.revisionId, item.relation, item.notes);
  }
}

function insertEvidence(db, analysisId, interviewId, evidence) {
  const target = interviewTarget(db, interviewId);
  const inserts = {
    snapshots: db.prepare('INSERT INTO interview_prep_snapshot_evidence (analysis_id, snapshot_id, reason) VALUES (?, ?, ?)'),
    artifacts: db.prepare('INSERT INTO interview_prep_artifact_evidence (analysis_id, artifact_id, reason) VALUES (?, ?, ?)'),
    profiles: db.prepare('INSERT INTO interview_prep_profile_evidence (analysis_id, profile_entry_id, reason) VALUES (?, ?, ?)')
  };
  for (const item of evidence.snapshots) {
    const valid = db.prepare(`
      SELECT 1 FROM opportunity_snapshots os
      LEFT JOIN job_postings jp ON jp.id=os.job_posting_id
      WHERE os.id=? AND (
        jp.job_opening_id=? OR EXISTS (
          SELECT 1 FROM application_artifacts aa
          WHERE aa.application_id=? AND aa.opportunity_snapshot_id=os.id
        )
      )
    `).get(item.id, target.openingId, target.applicationId);
    if (!valid) throw new InterviewPrepError('EVIDENCE_MISMATCH', `Snapshot ${item.id} does not belong to this application/opening`);
    inserts.snapshots.run(analysisId, item.id, item.reason);
  }
  for (const item of evidence.artifacts) {
    if (!db.prepare('SELECT 1 FROM application_artifacts WHERE id=? AND application_id=?').get(item.id, target.applicationId)) {
      throw new InterviewPrepError('EVIDENCE_MISMATCH', `Artifact ${item.id} does not belong to this application`);
    }
    inserts.artifacts.run(analysisId, item.id, item.reason);
  }
  for (const item of evidence.profiles) {
    if (!db.prepare('SELECT 1 FROM profile_entries WHERE id=?').get(item.id)) {
      throw new InterviewPrepError('INVALID_EVIDENCE', `Unknown profile evidence: ${item.id}`);
    }
    inserts.profiles.run(analysisId, item.id, item.reason);
  }
}

function buildAnalysisSourceManifest(db, input) {
  const target = interviewTarget(db, input.interviewId);
  const context = buildInterviewPrepContext(db, input.interviewId);
  const snapshots = (input.evidence?.snapshots || []).map((item) => {
    const row = db.prepare(`
      SELECT os.id, os.job_posting_id, os.normalized_sha256, os.raw_sha256,
        os.parser_name, os.parser_version, os.fetched_at, jp.job_opening_id
      FROM opportunity_snapshots os
      LEFT JOIN job_postings jp ON jp.id=os.job_posting_id
      WHERE os.id=?
    `).get(item.id);
    const linkedArtifact = row && db.prepare(`
      SELECT 1 FROM application_artifacts
      WHERE application_id=? AND opportunity_snapshot_id=?
    `).get(target.applicationId, item.id);
    if (!row || (row.job_opening_id !== target.openingId && !linkedArtifact)) {
      throw new InterviewPrepError('EVIDENCE_MISMATCH', `Snapshot ${item.id} does not belong to this application/opening`);
    }
    return { ...row, reason: item.reason };
  });
  const artifacts = (input.evidence?.artifacts || []).map((item) => {
    const row = db.prepare('SELECT * FROM application_artifacts WHERE id=? AND application_id=?').get(item.id, target.applicationId);
    if (!row) throw new InterviewPrepError('EVIDENCE_MISMATCH', `Artifact ${item.id} does not belong to this application`);
    return {
      id: row.id,
      applicationId: row.application_id,
      kind: row.kind,
      title: row.title,
      opportunitySnapshotId: row.opportunity_snapshot_id || null,
      recordDigest: prepSourceDigest(row),
      reason: item.reason
    };
  });
  const profiles = (input.evidence?.profiles || []).map((item) => {
    const row = db.prepare('SELECT * FROM profile_entries WHERE id=?').get(item.id);
    if (!row) throw new InterviewPrepError('INVALID_EVIDENCE', `Unknown profile evidence: ${item.id}`);
    return { id: row.id, recordDigest: prepSourceDigest(row), reason: item.reason };
  });
  const stories = (input.storyLinks || []).map((item) => {
    const row = db.prepare(`
      SELECT ps.id AS story_id, pr.id AS revision_id, pr.revision_number,
        pr.title, pr.canonical_text, pr.one_line_summary, pr.takeaway,
        pr.why_it_matters, pr.structure_style, pr.beats_json, pr.created_at,
        COALESCE(p.decision, ps.default_use_decision) AS permission_decision,
        p.expires_at
      FROM profile_stories ps
      JOIN profile_story_revisions pr ON pr.id=? AND pr.story_id=ps.id
      LEFT JOIN profile_story_permissions p ON p.story_id=ps.id AND p.purpose='interview'
      WHERE ps.id=?
    `).get(item.revisionId, item.storyId);
    if (!row || row.permission_decision !== 'allow'
      || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) {
      throw new InterviewPrepError('STORY_PERMISSION_REQUIRED', `Story ${item.storyId} revision ${item.revisionId} is not allowed for interview use`);
    }
    return {
      story_id: row.story_id,
      revision_id: row.revision_id,
      revision_number: row.revision_number,
      recordDigest: prepSourceDigest(row),
      permission_decision: row.permission_decision,
      expires_at: row.expires_at,
      relation: item.relation
    };
  });
  const selectors = {
    snapshots: (input.evidence?.snapshots || []).map((item) => ({ id: item.id, reason: item.reason })),
    artifacts: (input.evidence?.artifacts || []).map((item) => ({ id: item.id, reason: item.reason })),
    profiles: (input.evidence?.profiles || []).map((item) => ({ id: item.id, reason: item.reason })),
    storyLinks: (input.storyLinks || []).map((item) => ({ ...item })),
    skillFocus: (input.skillFocus || []).map((item) => ({ ...item }))
  };
  return {
    schemaVersion: 'interview-prep-source-manifest.v1',
    selectors,
    interview: pick(context.interview, [
      'id', 'application_id', 'round', 'round_type', 'sequence_no', 'scheduled_at',
      'scheduled_start_utc', 'timezone', 'duration_minutes', 'scheduling_status',
      'format', 'interviewer', 'meeting_url', 'location_text', 'outcome', 'lock_version',
      'opening_id', 'company_id', 'company', 'role', 'application_status', 'workflow_stage'
    ]),
    postings: context.postings,
    roleTypes: context.roleTypes,
    seniority: context.seniority,
    skillRequirements: context.skillRequirements,
    participants: context.participants,
    selectedEvidence: { snapshots, artifacts, profiles },
    selectedStories: stories
  };
}

function isInterviewPrepAnalysisStale(db, analysisId) {
  const analysis = db.prepare('SELECT * FROM interview_prep_analyses WHERE id=?').get(analysisId);
  if (!analysis) throw new InterviewPrepError('NOT_FOUND', `Interview-prep analysis not found: ${analysisId}`);
  try {
    const stored = JSON.parse(analysis.source_manifest_json);
    const selectors = stored.selectors || {};
    const current = buildAnalysisSourceManifest(db, {
      interviewId: analysis.interview_id,
      evidence: {
        snapshots: selectors.snapshots || [],
        artifacts: selectors.artifacts || [],
        profiles: selectors.profiles || []
      },
      storyLinks: selectors.storyLinks || [],
      skillFocus: selectors.skillFocus || []
    });
    return prepSourceDigest(current) !== analysis.source_digest;
  } catch {
    return true;
  }
}

function interviewTarget(db, interviewId) {
  const row = db.prepare(`
    SELECT i.id AS interview_id, i.application_id, a.job_opening_id
    FROM interviews i JOIN applications a ON a.id=i.application_id WHERE i.id=?
  `).get(positiveId(interviewId, 'interview id'));
  if (!row) throw new InterviewPrepError('NOT_FOUND', `Interview not found: ${interviewId}`);
  if (!row.job_opening_id) throw new InterviewPrepError('CATALOG_LINK_REQUIRED', `Application ${row.application_id} has no normalized opening`);
  return { interviewId: row.interview_id, applicationId: row.application_id, openingId: row.job_opening_id };
}

function idempotentInterviewOperation(db, command, idempotencyKey, request, action) {
  const requestSha = prepSourceDigest(request);
  const execute = () => {
    const existing = db.prepare('SELECT * FROM interview_prep_operations WHERE idempotency_key=?').get(idempotencyKey);
    if (existing) {
      if (existing.command !== command || existing.request_sha256 !== requestSha) {
        throw new InterviewPrepError('IDEMPOTENCY_CONFLICT', `Idempotency key ${idempotencyKey} was already used for another request`);
      }
      return JSON.parse(existing.result_json);
    }
    const result = action();
    db.prepare(`
      INSERT INTO interview_prep_operations (idempotency_key, command, request_sha256, result_json)
      VALUES (?, ?, ?, ?)
    `).run(idempotencyKey, command, requestSha, stableJson(result));
    return result;
  };
  return db.inTransaction ? execute() : db.transaction(execute).immediate();
}

function insertPrepEvent(db, analysisId, interviewId, eventKind, actor, notes, createdAt) {
  db.prepare(`
    INSERT INTO interview_prep_events (analysis_id, interview_id, event_kind, actor, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(analysisId, interviewId, eventKind, actor, notes, createdAt);
}

function latestPrepReview(db, analysisId) {
  return db.prepare(`
    SELECT * FROM interview_prep_events
    WHERE analysis_id=? AND event_kind IN ('approved','rejected')
    ORDER BY id DESC LIMIT 1
  `).get(analysisId) || null;
}

function idempotencyKeyValue(value, label) {
  const key = boundedString(value, label, 1, 500);
  if (/[\u0000-\u001f]/.test(key)) throw new InterviewPrepError('VALIDATION_ERROR', `${label} must contain printable characters`);
  return key;
}

function nullableExpectedId(value, label) {
  if (value === null || value === 'none') return null;
  if (value === undefined || value === '') throw new InterviewPrepError('VALIDATION_ERROR', `${label} is required; use "none" when no analysis is current`);
  return positiveId(value, label);
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function normalizeAnalysisInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InterviewPrepError('VALIDATION_ERROR', 'Analysis input must be an object');
  rejectUnknown(input, ['interviewId', 'status', 'title', 'executiveSummary', 'strategy', 'generatedBy', 'generatorVersion', 'sections', 'questions', 'skillFocus', 'storyLinks', 'evidence'], 'analysis');
  const result = {
    interviewId: positiveId(input.interviewId, 'interviewId'),
    status: enumeration(input.status || 'draft', ANALYSIS_STATUSES, 'status'),
    title: boundedString(input.title, 'title', 1, 300),
    executiveSummary: optionalString(input.executiveSummary, 'executiveSummary', 10_000),
    strategy: optionalString(input.strategy, 'strategy', 10_000),
    generatedBy: boundedString(input.generatedBy, 'generatedBy', 1, 200),
    generatorVersion: optionalString(input.generatorVersion, 'generatorVersion', 200),
    sections: array(input.sections, 'sections', 1, 50).map((item, index) => normalizeSection(item, index)),
    questions: array(input.questions || [], 'questions', 0, 200).map((item, index) => normalizeQuestion(item, index)),
    skillFocus: array(input.skillFocus || [], 'skillFocus', 0, 200).map((item, index) => normalizeSkillFocus(item, index)),
    storyLinks: array(input.storyLinks || [], 'storyLinks', 0, 100).map((item, index) => normalizeStoryLink(item, index)),
    evidence: normalizeEvidence(input.evidence || {})
  };
  return result;
}

function normalizeSection(value, index) {
  rejectUnknown(value, ['kind', 'heading', 'content'], `sections[${index}]`);
  return {
    kind: enumeration(value.kind, SECTION_KINDS, `sections[${index}].kind`),
    heading: boundedString(value.heading, `sections[${index}].heading`, 1, 300),
    content: boundedString(value.content, `sections[${index}].content`, 1, 50_000)
  };
}

function normalizeQuestion(value, index) {
  rejectUnknown(value, ['kind', 'prompt', 'suggestedAnswer', 'rationale', 'priority'], `questions[${index}]`);
  return {
    kind: enumeration(value.kind, QUESTION_KINDS, `questions[${index}].kind`),
    prompt: boundedString(value.prompt, `questions[${index}].prompt`, 1, 5000),
    suggestedAnswer: optionalString(value.suggestedAnswer, `questions[${index}].suggestedAnswer`, 20_000),
    rationale: optionalString(value.rationale, `questions[${index}].rationale`, 5000),
    priority: integer(value.priority === undefined ? 3 : value.priority, `questions[${index}].priority`, 1, 5)
  };
}

function normalizeSkillFocus(value, index) {
  rejectUnknown(value, ['skillId', 'requirementKind', 'focusKind', 'priority', 'notes', 'evidenceSnapshotId'], `skillFocus[${index}]`);
  return {
    skillId: positiveId(value.skillId, `skillFocus[${index}].skillId`),
    requirementKind: value.requirementKind === undefined || value.requirementKind === null ? null : boundedString(value.requirementKind, `skillFocus[${index}].requirementKind`, 1, 80),
    focusKind: enumeration(value.focusKind, FOCUS_KINDS, `skillFocus[${index}].focusKind`),
    priority: integer(value.priority === undefined ? 3 : value.priority, `skillFocus[${index}].priority`, 1, 5),
    notes: optionalString(value.notes, `skillFocus[${index}].notes`, 10_000),
    evidenceSnapshotId: value.evidenceSnapshotId === undefined || value.evidenceSnapshotId === null ? null : positiveId(value.evidenceSnapshotId, `skillFocus[${index}].evidenceSnapshotId`)
  };
}

function normalizeStoryLink(value, index) {
  rejectUnknown(value, ['storyId', 'revisionId', 'relation', 'notes'], `storyLinks[${index}]`);
  return {
    storyId: positiveId(value.storyId, `storyLinks[${index}].storyId`),
    revisionId: positiveId(value.revisionId, `storyLinks[${index}].revisionId`),
    relation: enumeration(value.relation, STORY_RELATIONS, `storyLinks[${index}].relation`),
    notes: optionalString(value.notes, `storyLinks[${index}].notes`, 10_000)
  };
}

function normalizeEvidence(value) {
  rejectUnknown(value, ['snapshots', 'artifacts', 'profiles'], 'evidence');
  const normalize = (items, label) => array(items || [], label, 0, 200).map((item, index) => {
    rejectUnknown(item, ['id', 'reason'], `${label}[${index}]`);
    return { id: positiveId(item.id, `${label}[${index}].id`), reason: boundedString(item.reason, `${label}[${index}].reason`, 1, 2000) };
  });
  return { snapshots: normalize(value.snapshots, 'evidence.snapshots'), artifacts: normalize(value.artifacts, 'evidence.artifacts'), profiles: normalize(value.profiles, 'evidence.profiles') };
}

function prepSourceDigest(context) {
  return crypto.createHash('sha256').update(stableJson(context)).digest('hex');
}

function createImmutableTriggers(db, table) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_${table}_immutable_update
    BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_${table}_immutable_delete
    BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END;
  `);
}

function ensureColumn(db, table, column, definition) {
  if (!tableExists(db, table)) throw new InterviewPrepError('SCHEMA_MISSING', `Required table is missing: ${table}`);
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function rejectUnknown(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InterviewPrepError('VALIDATION_ERROR', `${label} must be an object`);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new InterviewPrepError('VALIDATION_ERROR', `${label} has unknown field(s): ${unknown.sort().join(', ')}`);
}

function array(value, label, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new InterviewPrepError('VALIDATION_ERROR', `${label} must contain ${min}-${max} items`);
  return value;
}

function boundedString(value, label, min, max) {
  if (typeof value !== 'string') throw new InterviewPrepError('VALIDATION_ERROR', `${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new InterviewPrepError('VALIDATION_ERROR', `${label} must contain ${min}-${max} characters`);
  return normalized;
}

function optionalString(value, label, max) {
  if (value === undefined || value === null || value === '') return null;
  return boundedString(value, label, 1, max);
}

function integer(value, label, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new InterviewPrepError('VALIDATION_ERROR', `${label} must be an integer from ${min} to ${max}`);
  return number;
}

function positiveId(value, label) {
  return integer(value, label, 1, Number.MAX_SAFE_INTEGER);
}

function enumeration(value, allowed, label) {
  if (!allowed.has(value)) throw new InterviewPrepError('VALIDATION_ERROR', `${label} must be one of: ${[...allowed].join(', ')}`);
  return value;
}

function isoDateTime(value, label) {
  return strictIsoDateTime(value, label);
}

function strictIsoDateTime(value, label) {
  const text = boundedString(value, label, 1, 100);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)
    || !Number.isFinite(Date.parse(text))) {
    throw new InterviewPrepError('VALIDATION_ERROR', `${label} must be an ISO 8601 date-time with Z or an explicit offset`);
  }
  return text;
}

function timezoneValue(value, scheduledAt) {
  if (value !== undefined && value !== null && value !== '') {
    return boundedString(value, 'timezone', 1, 100);
  }
  if (String(scheduledAt).endsWith('Z')) return 'UTC';
  const match = String(scheduledAt).match(/([+-]\d{2}:\d{2})$/);
  return match ? `UTC${match[1]}` : null;
}

function optionalUrl(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const text = boundedString(value, label, 1, 4000);
  let parsed;
  try { parsed = new URL(text); }
  catch { throw new InterviewPrepError('VALIDATION_ERROR', `${label} must be a valid URL`); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new InterviewPrepError('VALIDATION_ERROR', `${label} must be an HTTP(S) URL without embedded credentials`);
  }
  return parsed.toString();
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

module.exports = {
  INTERVIEW_PREP_SCHEMA_VERSION,
  InterviewPrepError,
  migrateInterviewPrep,
  createScheduledInterview,
  updateScheduledInterview,
  listInterviewPrepQueue,
  buildInterviewPrepContext,
  createInterviewPrepAnalysis,
  reviewInterviewPrepAnalysis,
  selectCurrentInterviewPrep,
  generateDeterministicPrep,
  getInterviewPrepAnalysis,
  getCurrentInterviewPrep,
  isInterviewPrepAnalysisStale,
  prepSourceDigest
};
