'use strict';

// The application read model, including the v0.5 materials/forms workspace and
// the unified pipeline.
//
// The largest read model because an application is the join point of the whole
// system: the opening it targets, the postings that are its submission routes,
// the observed form surfaces and their fields, the material revisions and
// their reviews and selections, the packages that pin approved revisions, and
// the email threads correlated to it.
//
// Three rules run through all of it:
//
//   - ABSENT is not COMPLETE. A form with no observations reports coverage
//     unknown, never coverage clean; a historical application with no recorded
//     materials reports legacy-not-recorded, not "submitted without a resume".
//   - Protected fields never leak through a blocker message.
//     sanitizeApplicationReadinessBlockers rewrites any blocker that names or
//     quotes a protected field into a generic "requires human review", because
//     a blocker string is rendered and the field text is the sensitive part.
//   - The pipeline is applications UNION the opportunities that have not
//     become one; a promoted opportunity must appear exactly once, as its
//     application.

const {
  getDb,
  tableExists,
  safeJson
} = require('../store');
const {
  publicTagJoins,
  publicTagPredicate,
  scopeEntityCte,
  buildEntityFilter,
  pipelineApplicationStatusSql
} = require('../filters');
const {
  decoratePositionRow,
  deriveApplicationStatus,
  sortApplications
} = require('./rows');
const { listOpportunities } = require('./positions');
const { formatToken } = require('../html');
const { isProtectedApplicationField } = require('../../application-field-safety');
const {
  getApplicationMaterialsReadModel,
  getMaterialRevision,
  materialRevisionIsFresh
} = require('../../application-materials');
const { getApplicationStrategyReadModel } = require('../../application-strategy');
const { readApplicationOutgoingSummary } = require('./communications');
const { readCorrelationMetrics } = require('../../email-correlation/metrics');
const {
  readEffectiveApplicationInformationRequests,
  summarizeEffectiveApplicationInformationRequests
} = require('../../profile-normalization');

function listApplications(filters = {}, { scope = 'applications', pipeline = false } = {}) {
  const db = getDb();
  if (!tableExists(db, 'applications')) return [];
  const extraClauses = [];
  const filterParams = {};
  if (pipeline && filters.status) {
    extraClauses.push(pipelineApplicationStatusSql(filters.status));
    if (!['opportunity', 'accepted', 'rejected', 'prospective', 'submitted', 'archived', 'offer'].includes(filters.status)) {
      filterParams.filter_pipeline_status = filters.status;
    }
  }
  const sqlFilters = buildEntityFilter({ ...filters, status: pipeline ? null : filters.status }, scope, {
    statusExpression: 'a.status',
    workflowExpression: 'a.workflow_stage',
    extraClauses,
    queryExpressions: [
      'c.canonical_name', 'a.company', 'jo.canonical_title', 'a.role', 'a.status', 'a.workflow_stage',
      `(SELECT group_concat(rt.label, ' ') FROM opening_role_types search_ort JOIN role_types rt ON rt.id=search_ort.role_type_id WHERE search_ort.job_opening_id=a.job_opening_id)`,
      `(SELECT group_concat(sl.label, ' ') FROM opening_seniority_levels search_osl JOIN seniority_levels sl ON sl.id=search_osl.seniority_level_id WHERE search_osl.job_opening_id=a.job_opening_id)`,
      tableExists(db, 'application_tags') ? `(SELECT group_concat(t.label, ' ') FROM application_tags search_at JOIN tags t ON t.id=search_at.tag_id ${publicTagJoins('t')} WHERE search_at.application_id=a.id AND ${publicTagPredicate()})` : "''",
      tableExists(db, 'opening_tags') ? `(SELECT group_concat(t.label, ' ') FROM opening_tags search_ot JOIN tags t ON t.id=search_ot.tag_id ${publicTagJoins('t')} WHERE search_ot.job_opening_id=a.job_opening_id AND ${publicTagPredicate()})` : "''"
    ]
  });
  const rows = db.prepare(`
    WITH entities AS (${scopeEntityCte(scope, db)}), activity AS (
      SELECT id AS application_id, status_changed_at AS activity_at, 'Status changed' AS activity_kind
      FROM applications
      WHERE status_changed_at IS NOT NULL
      UNION ALL
      SELECT id AS application_id, updated_at AS activity_at, 'Application updated' AS activity_kind
      FROM applications
      WHERE updated_at IS NOT NULL
      UNION ALL
      SELECT application_id, scheduled_at AS activity_at, round || ' interview scheduled' AS activity_kind
      FROM interviews
      WHERE scheduled_at IS NOT NULL
      UNION ALL
      SELECT application_id, updated_at AS activity_at, round || ' interview updated' AS activity_kind
      FROM interviews
      WHERE updated_at IS NOT NULL
      UNION ALL
      SELECT application_id, captured_at AS activity_at, kind || ' artifact captured' AS activity_kind
      FROM application_artifacts
      WHERE captured_at IS NOT NULL
      UNION ALL
      SELECT application_id, created_at AS activity_at, 'Assessment created' AS activity_kind
      FROM application_assessments
      WHERE created_at IS NOT NULL
      UNION ALL
      SELECT application_id, decided_at AS activity_at, 'Assessment ' || decision AS activity_kind
      FROM assessment_review_gates
      WHERE decided_at IS NOT NULL
      UNION ALL
      SELECT application_id, updated_at AS activity_at, 'Package ' || package_status AS activity_kind
      FROM application_packages
      WHERE updated_at IS NOT NULL
      UNION ALL
      SELECT application_id, created_at AS activity_at, event_kind || ': ' || to_stage AS activity_kind
      FROM application_lifecycle_events
      WHERE created_at IS NOT NULL
    ), ranked_activity AS (
      SELECT
        application_id,
        activity_at,
        activity_kind,
        ROW_NUMBER() OVER (
          PARTITION BY application_id
          ORDER BY datetime(activity_at) DESC, activity_at DESC, activity_kind DESC
        ) AS rank
      FROM activity
    )
    SELECT
      a.id,
      COALESCE(c.canonical_name, a.company) AS company,
      COALESCE(jo.canonical_title, a.role) AS role,
      jo.company_id,
      a.job_opening_id,
      a.primary_job_posting_id,
      (SELECT count(*) FROM application_postings ap WHERE ap.application_id=a.id) AS posting_count,
      a.status,
      a.workflow_stage,
      a.applied_date,
      (SELECT outcome FROM offers WHERE application_id=a.id LIMIT 1) AS offer_outcome,
      (SELECT group_concat(ort.role_type_id) FROM opening_role_types ort WHERE ort.job_opening_id=a.job_opening_id) AS role_type_ids,
      (SELECT group_concat(rt.label, ', ') FROM opening_role_types ort JOIN role_types rt ON rt.id=ort.role_type_id WHERE ort.job_opening_id=a.job_opening_id ORDER BY ort.is_primary DESC, rt.label) AS role_types,
      (SELECT group_concat(osl.seniority_level_id) FROM opening_seniority_levels osl WHERE osl.job_opening_id=a.job_opening_id) AS seniority_ids,
      (SELECT group_concat(sl.label, ', ') FROM opening_seniority_levels osl JOIN seniority_levels sl ON sl.id=osl.seniority_level_id WHERE osl.job_opening_id=a.job_opening_id ORDER BY osl.is_primary DESC, sl.sort_rank) AS seniority_levels,
      ${tableExists(db, 'application_tags') ? `(SELECT group_concat(t.label, ', ') FROM application_tags at JOIN tags t ON t.id=at.tag_id ${publicTagJoins('t')} WHERE at.application_id=a.id AND ${publicTagPredicate()} ORDER BY lower(t.label))` : 'NULL'} AS application_tags,
      ${tableExists(db, 'opening_tags') ? `(SELECT group_concat(t.label, ', ') FROM opening_tags ot JOIN tags t ON t.id=ot.tag_id ${publicTagJoins('t')} WHERE ot.job_opening_id=a.job_opening_id AND ${publicTagPredicate()} ORDER BY lower(t.label))` : 'NULL'} AS opening_tags,
      ${tableExists(db, 'opportunity_tag_links') ? `(SELECT group_concat(t.label, ', ') FROM opportunity_tag_links otl JOIN tags t ON t.id=otl.tag_id ${publicTagJoins('t')} WHERE otl.opportunity_id=a.source_opportunity_id AND ${publicTagPredicate()} ORDER BY lower(t.label))` : 'NULL'} AS inherited_tags,
      ranked_activity.activity_at AS latest_activity_at,
      ranked_activity.activity_kind AS latest_activity_kind,
      (
        SELECT package_status
        FROM application_packages
        WHERE application_id = a.id
        ORDER BY datetime(updated_at) DESC, id DESC
        LIMIT 1
      ) AS package_status,
      (
        SELECT updated_at
        FROM application_packages
        WHERE application_id = a.id
        ORDER BY datetime(updated_at) DESC, id DESC
        LIMIT 1
      ) AS package_updated_at
    FROM applications a
    JOIN entities e ON e.entity_key='application:' || a.id
    LEFT JOIN job_openings jo ON jo.id=a.job_opening_id
    LEFT JOIN companies c ON c.id=jo.company_id
    LEFT JOIN ranked_activity
      ON ranked_activity.application_id = a.id AND ranked_activity.rank = 1
    ${sqlFilters.clause}
    ORDER BY datetime(COALESCE(ranked_activity.activity_at, a.created_at)) DESC, a.id DESC
  `).all({ ...sqlFilters.params, ...filterParams });
  const rowIds = rows.map((row) => row.id);
  const gapMap = listMissingProfileSignals(db, rowIds);
  const materialReadinessMap = listApplicationMaterialReadinessSignals(db, rowIds);
  return rows.map((row) => decoratePositionRow({
    ...row,
    item_type: 'application',
    derived_status: deriveApplicationStatus(row),
    missing_profile: gapMap.get(row.id) || null,
    material_readiness: materialReadinessMap.get(row.id) || null
  }));
}

function listApplicationMaterialReadinessSignals(db, applicationIds) {
  if (!applicationIds.length) return new Map();
  const selected = new Set(applicationIds);
  if (tableExists(db, 'application_material_readiness')) {
    return new Map(db.prepare('SELECT * FROM application_material_readiness').all()
      .filter((row) => selected.has(row.application_id))
      .map((row) => [row.application_id, row]));
  }
  if (tableExists(db, 'application_preparation_plans') && tableExists(db, 'application_materials')) {
    const values = [];
    for (const applicationId of applicationIds) {
      try {
        const model = getApplicationMaterialsReadModel(db, applicationId);
        values.push([applicationId, {
          application_id: applicationId,
          state: model.readiness.ready ? 'package-ready' : model.plan.mode === 'legacy-import' ? 'legacy-not-recorded' : 'preparation-incomplete',
          readiness_label: model.readiness.ready ? 'Package-ready' : model.plan.mode === 'legacy-import' ? 'Legacy / materials not recorded' : 'Preparation incomplete',
          is_draftable: Boolean(model.readiness.canDraft),
          is_package_ready: Boolean(model.readiness.ready),
          blocker_count: model.readiness.blockers?.length || 0
        }]);
      } catch (error) {
        if (error?.code !== 'PREPARATION_PLAN_MISSING') throw error;
      }
    }
    return new Map(values);
  }
  const counts = db.prepare(`
    SELECT a.id AS application_id,a.workflow_stage,a.applied_date,
      (SELECT count(*) FROM cover_letters c WHERE c.application_id=a.id) AS cover_letter_count,
      (SELECT count(*) FROM resume_versions r WHERE r.application_id=a.id) AS resume_count
    FROM applications a
  `).all().filter((row) => selected.has(row.application_id));
  return new Map(counts.map((row) => [row.application_id, {
    ...row,
    compatibility_only: 1,
    is_historical: Boolean(row.applied_date) || ['submitted', 'interviewing', 'offer', 'declined', 'archived'].includes(row.workflow_stage)
  }]));
}

function readApplicationWorkspace(id) {
  const db = getDb();
  if (!tableExists(db, 'applications')) return null;
  const application = db.prepare(`
    SELECT a.*, COALESCE(c.canonical_name,a.company) AS display_company,
      COALESCE(jo.canonical_title,a.role) AS display_role,
      jo.company_id, jo.status AS opening_status
    FROM applications a
    LEFT JOIN job_openings jo ON jo.id=a.job_opening_id
    LEFT JOIN companies c ON c.id=jo.company_id
    WHERE a.id=?
  `).get(id);
  if (!application) return null;

  const opening = application.job_opening_id && tableExists(db, 'job_openings')
    ? db.prepare(`
        SELECT jo.*,c.canonical_name AS company
        FROM job_openings jo JOIN companies c ON c.id=jo.company_id WHERE jo.id=?
      `).get(application.job_opening_id) || null
    : null;
  const postings = tableExists(db, 'application_postings') && tableExists(db, 'job_postings')
    ? db.prepare(`
        SELECT jp.id,jp.canonical_url,jp.external_id,jp.state,ap.relation,ap.is_primary,
          pp.name AS platform,pv.label AS venue,pv.board_key
        FROM application_postings ap JOIN job_postings jp ON jp.id=ap.job_posting_id
        JOIN posting_venues pv ON pv.id=jp.posting_venue_id
        JOIN posting_platforms pp ON pp.id=pv.posting_platform_id
        WHERE ap.application_id=? ORDER BY ap.is_primary DESC,jp.id
      `).all(id)
    : [];
  const informationRequests = readApplicationInformationRequests(db, application);
  const gapSummary = summarizeApplicationInformationRequests(application.id, informationRequests);
  const legacyCoverLetters = tableExists(db, 'cover_letters')
    ? db.prepare('SELECT id,assessment_id,assessment_gate_id,created_at,updated_at,content IS NOT NULL AS has_content,attachment_path IS NOT NULL AS has_attachment FROM cover_letters WHERE application_id=? ORDER BY datetime(COALESCE(updated_at,created_at)) DESC,id DESC').all(id)
    : [];
  const legacyResumes = tableExists(db, 'resume_versions')
    ? db.prepare('SELECT id,assessment_id,assessment_gate_id,created_at,updated_at,content IS NOT NULL AS has_content,attachment_path IS NOT NULL AS has_attachment FROM resume_versions WHERE application_id=? ORDER BY datetime(COALESCE(updated_at,created_at)) DESC,id DESC').all(id)
    : [];
  const assessments = tableExists(db, 'application_assessments')
    ? db.prepare('SELECT id,artifact_id,created_at FROM application_assessments WHERE application_id=? ORDER BY id DESC').all(id)
    : [];
  const assessmentReviews = tableExists(db, 'assessment_review_gates')
    ? db.prepare('SELECT id,artifact_id,decision,decided_by,decided_at,notes FROM assessment_review_gates WHERE application_id=? ORDER BY datetime(decided_at) DESC,id DESC').all(id)
    : [];
  const packages = tableExists(db, 'application_packages')
    ? db.prepare('SELECT id,package_status,cover_letter_id,resume_id,assessment_id,assessment_gate_id,content_sha256,created_at,updated_at FROM application_packages WHERE application_id=? ORDER BY datetime(updated_at) DESC,id DESC').all(id)
    : [];
  const lifecycle = tableExists(db, 'application_lifecycle_events')
    ? db.prepare('SELECT id,from_stage,to_stage,event_kind,notes,created_at FROM application_lifecycle_events WHERE application_id=? ORDER BY datetime(created_at) DESC,id DESC LIMIT 300').all(id)
    : [];

  const v05 = readV05ApplicationWorkspace(db, id);
  const strategy = tableExists(db, 'application_strategy_revisions')
    ? getApplicationStrategyReadModel(db, id)
    : null;
  const communications = readApplicationCommunicationSummary(db, id);
  const correlationMetrics = readCorrelationMetrics(db, { applicationId: id });
  return {
    application: { ...application, company: application.display_company, role: application.display_role },
    opening,
    postings,
    informationRequests,
    gapSummary,
    legacyCoverLetters,
    legacyResumes,
    assessments,
    assessmentReviews,
    packages,
    lifecycle,
    strategy,
    communications,
    correlationMetrics,
    ...v05
  };
}

function readApplicationCommunicationSummary(db, applicationId) {
  const required = [
    'job_email_application_links', 'job_email_message_refs', 'job_email_thread_messages',
    'job_email_threads', 'job_email_demeanor_observations', 'job_email_tone_decisions',
    'job_email_reply_draft_style_bindings', 'job_email_reply_draft_events'
  ];
  if (!required.every((table) => tableExists(db, table))) return null;
  const linkSource = db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name='active_job_email_application_links'").get()
    ? 'active_job_email_application_links'
    : 'job_email_application_links';
  const counts = db.prepare(`
    SELECT
      count(DISTINCT link.message_ref_id) AS message_count,
      count(DISTINCT thread_message.thread_ref_id) AS thread_count,
      count(DISTINCT observation.observation_id) AS observation_count,
      count(DISTINCT tone.decision_id) AS tone_decision_count,
      count(DISTINCT style.proposal_id) AS styled_draft_count
    FROM ${linkSource} link
    LEFT JOIN job_email_thread_messages thread_message ON thread_message.message_ref_id=link.message_ref_id
    LEFT JOIN job_email_demeanor_observations observation ON observation.message_ref_id=link.message_ref_id
    LEFT JOIN job_email_tone_decisions tone ON tone.message_ref_id=link.message_ref_id
    LEFT JOIN job_email_reply_draft_proposals proposal ON proposal.message_ref_id=link.message_ref_id
    LEFT JOIN job_email_reply_draft_style_bindings style ON style.proposal_id=proposal.proposal_id
    WHERE link.application_id=?
  `).get(applicationId);
  const toneDecisions = db.prepare(`
    SELECT tone.decision_id,tone.purpose,tone.style_profile_id,tone.voice_revision_id,
      tone.source_state_sha256,tone.created_at,
      json_extract(tone.decision_json,'$.selected.dimensions.formality') AS formality,
      json_extract(tone.decision_json,'$.selected.dimensions.warmth') AS warmth,
      json_extract(tone.decision_json,'$.selected.dimensions.energy') AS energy,
      json_extract(tone.decision_json,'$.selected.dimensions.directness') AS directness,
      json_extract(tone.decision_json,'$.selected.dimensions.verbosity') AS verbosity,
      json_extract(tone.decision_json,'$.selected.delivery.exclamationPolicy') AS exclamation_policy,
      json_extract(tone.decision_json,'$.selected.delivery.emojiPolicy') AS emoji_policy
    FROM job_email_tone_decisions tone
    JOIN ${linkSource} link ON link.message_ref_id=tone.message_ref_id
    WHERE link.application_id=? ORDER BY tone.created_at DESC,tone.decision_id DESC LIMIT 20
  `).all(applicationId);
  const drafts = db.prepare(`
    SELECT style.proposal_id,style.tone_decision_id,style.style_profile_id,style.voice_revision_id,
      style.source_state_sha256,style.created_at,proposal.proposal_json,
      (SELECT event_kind FROM job_email_reply_draft_events event
       WHERE event.proposal_id=style.proposal_id ORDER BY event.id DESC LIMIT 1) AS review_state
    FROM job_email_reply_draft_style_bindings style
    JOIN job_email_reply_draft_proposals proposal ON proposal.proposal_id=style.proposal_id
    JOIN ${linkSource} link ON link.message_ref_id=proposal.message_ref_id
    WHERE link.application_id=? ORDER BY style.created_at DESC,style.proposal_id DESC LIMIT 20
  `).all(applicationId);
  return {
    counts: Object.fromEntries(Object.entries(counts || {}).map(([key, value]) => [key, Number(value || 0)])),
    toneDecisions,
    drafts: drafts.map((draft) => {
      let proposal = null;
      try { proposal = JSON.parse(draft.proposal_json || 'null'); } catch { proposal = null; }
      return { ...draft, proposal };
    }),
    // The live v2 outgoing lane for THIS application: lifecycle metadata plus
    // the approval-policy mode that governs it. Null on a store predating v2.
    outgoing: readApplicationOutgoingSummary(db, applicationId),
    protectedPayloadRedacted: false
  };
}

function readApplicationInformationRequests(db, application) {
  if (!tableExists(db, 'application_information_request_current')) return [];
  return readEffectiveApplicationInformationRequests(db, application.id).map((request) => ({
    ...request,
    request_scope: request.request_scope === 'opportunity' ? 'source-opportunity' : request.request_scope,
    assessment_state: request.effective_assessment_state
  }));
}

function summarizeApplicationInformationRequests(applicationId, requests) {
  return summarizeEffectiveApplicationInformationRequests(applicationId, requests);
}

function readV05ApplicationWorkspace(db, applicationId) {
  const requiredTables = [
    'application_preparation_plans', 'application_preparation_modes',
    'application_materials', 'application_material_kinds',
    'application_material_revisions', 'application_material_revision_current_state'
  ];
  if (!requiredTables.every((table) => tableExists(db, table))) {
    return {
      materialsSchemaAvailable: false,
      plan: null,
      readiness: null,
      materialGroups: [],
      surveys: [],
      questions: [],
      materialReviews: [],
      materialSelections: [],
      preparationPackages: [],
      preparationHistory: []
    };
  }
  const authoritative = getApplicationMaterialsReadModel(db, applicationId);
  const plan = authoritative.plan;
  const requirements = authoritative.requirements.map((row) => ({
    ...row,
    kind: row.material_kind,
    kind_label: row.material_kind_label
  }));
  const materials = authoritative.materials.map((material) => ({
    ...material,
    material_id: material.id,
    is_baseline: ['resume', 'cover-letter'].includes(material.kind),
    revisions: material.revisions.map((revision) => ({
      ...revision,
      is_head: Boolean(revision.is_head),
      is_selected: Boolean(revision.is_selected),
      is_stale: !materialRevisionIsFresh(db, revision),
      review_decision: revision.latest_review_decision || 'unreviewed'
    }))
  }));
  const requirementByMaterial = new Map(requirements.map((row) => [`${row.kind}:${row.form_field_id || ''}`, row]));
  const materialGroups = materials.map((material) => {
    const groupRevisions = material.revisions;
    return {
      ...material,
      requirement: requirementByMaterial.get(`${material.kind}:${material.form_field_id || ''}`) || null,
      revision_count: groupRevisions.length,
      revisions: groupRevisions
    };
  });
  const materialReviews = tableExists(db, 'application_material_review_events')
    ? db.prepare(`
        SELECT e.id,e.revision_id,e.reviewed_by,e.notes,e.reviewed_at,e.created_at,
          d.slug AS decision,r.revision_number,m.form_field_id,k.slug AS kind
        FROM application_material_review_events e
        JOIN application_material_review_decisions d ON d.id=e.decision_id
        JOIN application_material_revisions r ON r.id=e.revision_id
        JOIN application_materials m ON m.id=r.material_id
        JOIN application_material_kinds k ON k.id=m.material_kind_id
        WHERE m.application_id=? ORDER BY datetime(e.reviewed_at) DESC,e.id DESC
      `).all(applicationId).map((row) => ({
        ...row,
        is_sensitive: Boolean(row.form_field_id && isProtectedApplicationField(readV05FormFieldDescriptor(db, row.form_field_id)))
      }))
    : [];
  const materialSelections = tableExists(db, 'application_material_selection_events')
    ? db.prepare(`
        SELECT e.id,e.material_id,e.revision_id,e.previous_revision_id,e.selected_by,e.selected_at,e.created_at,
          r.revision_number,m.form_field_id,k.slug AS kind
        FROM application_material_selection_events e
        JOIN application_materials m ON m.id=e.material_id
        JOIN application_material_kinds k ON k.id=m.material_kind_id
        JOIN application_material_revisions r ON r.id=e.revision_id
        WHERE m.application_id=? ORDER BY datetime(e.selected_at) DESC,e.id DESC
      `).all(applicationId)
    : [];
  const preparationPackages = authoritative.packages
    .filter((row) => row.readiness_sha256)
    .map((row) => ({
      ...row,
      package_id: row.id,
      is_stale: Boolean(row.preparation_snapshot_stale)
    }));
  const preparationHistory = buildV05PreparationHistory(db, applicationId, materialGroups, materialReviews, materialSelections, preparationPackages);
  const questions = readV05ApplicationQuestions(db, applicationId, materialGroups);
  const surveys = readV05ApplicationSurveys(db, applicationId);
  const readiness = {
    ...authoritative.readiness,
    label: plan.mode === 'legacy-import'
      ? 'Legacy / materials not recorded'
      : authoritative.readiness.ready
      ? 'Package-ready'
      : authoritative.readiness.canDraft ? 'Draftable, not package-ready' : 'Preparation blocked',
    state: plan.mode === 'legacy-import' ? 'legacy-not-recorded' : authoritative.readiness.ready ? 'package-ready' : 'blocked',
    blockers: sanitizeApplicationReadinessBlockers(db, applicationId, authoritative.readiness.blockers || []),
    blocker_count: authoritative.readiness.blockers?.length || 0,
    is_draftable: Boolean(authoritative.readiness.canDraft),
    is_package_ready: Boolean(authoritative.readiness.ready)
  };
  return {
    materialsSchemaAvailable: true,
    plan,
    readiness,
    materialGroups,
    surveys,
    questions,
    materialReviews,
    materialSelections,
    preparationPackages,
    preparationHistory
  };
}

function readApplicationMaterial(applicationId, materialId) {
  const db = getDb();
  if (!tableExists(db, 'application_materials') || !tableExists(db, 'application_material_revisions')) return null;
  return readV05ApplicationMaterial(db, applicationId, materialId);
}

function readV05ApplicationMaterial(db, applicationId, revisionId) {
  if (!tableExists(db, 'application_material_revision_current_state')) return null;
  let revision;
  try {
    revision = getMaterialRevision(db, revisionId, applicationId);
  } catch (error) {
    if (error?.code === 'NOT_FOUND') return null;
    throw error;
  }
  const application = readApplicationIdentity(db, applicationId);
  if (!application) return null;
  const reviews = db.prepare(`
    SELECT e.id,e.render_id,d.slug AS decision,e.reviewed_by,e.notes,e.reviewed_at,e.created_at
    FROM application_material_review_events e
    JOIN application_material_review_decisions d ON d.id=e.decision_id
    WHERE e.revision_id=? ORDER BY datetime(e.reviewed_at),e.id
  `).all(revision.id);
  const selectionEvents = db.prepare(`
    SELECT id,previous_revision_id,revision_id,selected_by,selected_at,created_at
    FROM application_material_selection_events
    WHERE material_id=? ORDER BY datetime(selected_at),id
  `).all(revision.material_id);
  const formField = revision.form_field_id ? readV05FormFieldDescriptor(db, revision.form_field_id) : null;
  return {
    application,
    revision,
    kind: revision.material_kind,
    reviewDecision: revision.latest_review_decision || 'unreviewed',
    isSelected: Boolean(revision.is_selected),
    isHead: Boolean(revision.is_head),
    isStale: !materialRevisionIsFresh(db, revision),
    isSensitive: isProtectedApplicationField(formField),
    sensitivity: formField?.sensitivity || null,
    sourceManifestSha256: revision.sourceManifest?.source_manifest_sha256 || revision.source_manifest_sha256,
    reviews,
    selectionEvents
  };
}

function readApplicationQuestion(applicationId, questionId) {
  const db = getDb();
  return readV05ApplicationQuestion(db, applicationId, questionId);
}

function readV05ApplicationQuestion(db, applicationId, questionId) {
  const surveys = readV05ApplicationSurveys(db, applicationId);
  const revisionIds = surveys.map((survey) => survey.revision_id).filter(Boolean);
  if (!revisionIds.length || !tableExists(db, 'application_form_fields')) return null;
  const placeholders = revisionIds.map(() => '?').join(',');
  const question = db.prepare(`
    SELECT f.*,ik.slug AS input_kind,req.slug AS requiredness,sens.slug AS sensitivity,
      obs.slug AS observation_state,pif.slug AS information_field_slug,
      r.surface_id,s.job_posting_id,r.observed_at
    FROM application_form_fields f
    JOIN application_form_revisions r ON r.id=f.revision_id
    JOIN application_form_surfaces s ON s.id=r.surface_id
    JOIN application_form_input_kinds ik ON ik.id=f.input_kind_id
    JOIN information_requiredness_levels req ON req.id=f.requiredness_id
    JOIN information_sensitivity_levels sens ON sens.id=f.sensitivity_level_id
    JOIN application_form_observation_states obs ON obs.id=f.observation_state_id
    LEFT JOIN profile_information_fields pif ON pif.id=f.profile_information_field_id
    WHERE f.id=? AND f.revision_id IN (${placeholders})
  `).get(questionId, ...revisionIds);
  if (!question) return null;
  const application = readApplicationIdentity(db, applicationId);
  const options = tableExists(db, 'application_form_field_options')
    ? db.prepare('SELECT id,position,label FROM application_form_field_options WHERE field_id=? ORDER BY position,id').all(questionId)
    : [];
  const constraints = safeJson(question.constraints_json, {});
  const answerMaterial = tableExists(db, 'application_materials')
    ? db.prepare(`
        SELECT m.id,k.slug AS kind FROM application_materials m
        JOIN application_material_kinds k ON k.id=m.material_kind_id
        WHERE m.application_id=? AND m.form_field_id=? AND k.slug='form-answer'
      `).get(applicationId, questionId)
    : null;
  const answerRevisions = answerMaterial && tableExists(db, 'application_material_revision_current_state')
    ? db.prepare(`
        SELECT * FROM application_material_revision_current_state
        WHERE material_id=? ORDER BY revision_number DESC,id DESC
      `).all(answerMaterial.id).map((row) => ({
        ...row,
        review_decision: row.latest_review_decision || 'unreviewed'
      }))
    : [];
  const sensitive = isProtectedApplicationField(question);
  return {
    application,
    question,
    options,
    constraints,
    answerMaterial,
    answerRevisions,
    isSensitive: sensitive
  };
}

function readApplicationIdentity(db, applicationId) {
  return db.prepare(`
    SELECT a.*,COALESCE(c.canonical_name,a.company) AS company,
      COALESCE(jo.canonical_title,a.role) AS role
    FROM applications a LEFT JOIN job_openings jo ON jo.id=a.job_opening_id
    LEFT JOIN companies c ON c.id=jo.company_id WHERE a.id=?
  `).get(applicationId) || null;
}

function sanitizeApplicationReadinessBlockers(db, applicationId, blockers) {
  const sensitiveFields = tableExists(db, 'application_form_fields')
    ? db.prepare(`
        SELECT DISTINCT f.id,f.provider_field_key,f.label,f.help_text,
          s.slug AS sensitivity,ik.slug AS input_kind,pif.slug AS information_field_slug
        FROM application_form_fields f
        JOIN application_form_revisions fr ON fr.id=f.revision_id
        JOIN information_sensitivity_levels s ON s.id=f.sensitivity_level_id
        JOIN application_form_input_kinds ik ON ik.id=f.input_kind_id
        LEFT JOIN profile_information_fields pif ON pif.id=f.profile_information_field_id
        LEFT JOIN application_application_form_surfaces al
          ON al.surface_id=fr.surface_id AND al.application_id=@applicationId
        LEFT JOIN applications a ON a.id=@applicationId
        LEFT JOIN opportunity_application_form_surfaces ol
          ON ol.surface_id=fr.surface_id AND ol.opportunity_id=a.source_opportunity_id
        WHERE al.application_id IS NOT NULL OR ol.opportunity_id IS NOT NULL
      `).all({ applicationId }).filter(isProtectedApplicationField)
    : [];
  const sensitiveIds = new Set(sensitiveFields.map((field) => field.id));
  const application = db.prepare('SELECT source_opportunity_id FROM applications WHERE id=?').get(applicationId) || {};
  const sensitiveRequests = [];
  if (tableExists(db, 'application_information_request_current')) {
    sensitiveRequests.push(...db.prepare(`
      SELECT c.*,s.slug AS sensitivity,'application' AS request_scope
      FROM application_information_request_current c
      JOIN profile_information_fields f ON f.id=c.information_field_id
      JOIN information_sensitivity_levels s ON s.id=f.sensitivity_level_id
      WHERE c.application_id=?
    `).all(applicationId).filter((request) => isProtectedApplicationField({
      ...request,
      label: request.information_field_label || request.requested_label,
      prompt: request.raw_prompt,
      help_text: request.requested_label
    })));
  }
  if (application.source_opportunity_id && tableExists(db, 'opportunity_information_request_current')) {
    sensitiveRequests.push(...db.prepare(`
      SELECT c.*,s.slug AS sensitivity,'opportunity' AS request_scope
      FROM opportunity_information_request_current c
      JOIN profile_information_fields f ON f.id=c.information_field_id
      JOIN information_sensitivity_levels s ON s.id=f.sensitivity_level_id
      WHERE c.opportunity_id=?
    `).all(application.source_opportunity_id).filter((request) => isProtectedApplicationField({
      ...request,
      label: request.information_field_label || request.requested_label,
      prompt: request.raw_prompt,
      help_text: request.requested_label
    })));
  }
  const sensitiveRequestKeys = new Set(sensitiveRequests.map((request) => `${request.request_scope}:${request.id}`));
  return blockers.map((blocker) => {
    if (!blocker || typeof blocker !== 'object') return blocker;
    let fieldId = Number(blocker.formFieldId) || null;
    if (!fieldId && blocker.revisionId && tableExists(db, 'application_material_revisions')) {
      fieldId = db.prepare(`
        SELECT m.form_field_id
        FROM application_material_revisions r
        JOIN application_materials m ON m.id=r.material_id
        WHERE r.id=?
      `).get(blocker.revisionId)?.form_field_id || null;
    }
    const containsSensitiveLabel = sensitiveFields.some((field) => field.label && String(blocker.message || '').includes(field.label));
    const requestKey = blocker.requestScope && blocker.requestId ? `${blocker.requestScope}:${blocker.requestId}` : null;
    const containsSensitiveRequestText = sensitiveRequests.some((request) => [
      request.information_field_label,
      request.requested_label,
      request.raw_prompt
    ].filter(Boolean).some((value) => String(blocker.message || '').includes(String(value))));
    if (!sensitiveIds.has(fieldId)
      && !containsSensitiveLabel
      && !(requestKey && sensitiveRequestKeys.has(requestKey))
      && !containsSensitiveRequestText) return blocker;
    return {
      ...blocker,
      message: blocker.code === 'PROTECTED_RESPONSE_REQUIRES_HUMAN'
        ? 'A protected application field requires an explicitly human-authored, reviewed answer.'
        : 'A protected application field still requires human review or resolution.'
    };
  });
}

function buildV05PreparationHistory(db, applicationId, groups, reviews, selections, packages) {
  const history = [];
  for (const group of groups) for (const revision of group.revisions) history.push({
    created_at: revision.created_at,
    event_kind: `${group.kind} revision created`,
    detail: `Revision ${revision.revision_number} · ${formatToken(revision.revision_stage || 'rough-draft')}`
  });
  for (const review of reviews) history.push({
    created_at: review.reviewed_at || review.created_at,
    event_kind: `${review.kind} review`,
    detail: `Revision ${review.revision_number} · ${formatToken(review.decision)}`
  });
  for (const selection of selections) history.push({
    created_at: selection.selected_at || selection.created_at,
    event_kind: `${selection.kind} selected`,
    detail: `Revision ${selection.revision_number}`
  });
  for (const item of packages) history.push({
    created_at: item.created_at,
    event_kind: 'package snapshot',
    detail: `Package #${item.application_package_id}`
  });
  if (tableExists(db, 'application_preparation_uncertainty_events')) {
    for (const event of db.prepare(`
      SELECT accepted_at AS created_at,'form uncertainty accepted' AS event_kind,
        'Human accepted the recorded uncertainty for this exact form state; reason retained in the private audit log.' AS detail
      FROM application_preparation_uncertainty_events WHERE application_id=? ORDER BY id DESC
    `).all(applicationId)) history.push(event);
  }
  return history;
}

function readV05ApplicationSurveys(db, applicationId) {
  const required = [
    'application_form_surfaces', 'application_form_revisions', 'application_form_coverage_states',
    'application_form_revision_reviews', 'application_form_review_decisions'
  ];
  if (!required.every((table) => tableExists(db, table))) return [];
  const application = db.prepare('SELECT source_opportunity_id,primary_job_posting_id FROM applications WHERE id=?').get(applicationId);
  if (!application) return [];
  const surfaces = db.prepare(`
    SELECT DISTINCT s.id,s.job_posting_id,
      jp.canonical_url AS public_url,pp.name AS platform,pv.label AS venue
    FROM application_form_surfaces s
    LEFT JOIN application_application_form_surfaces al
      ON al.surface_id=s.id AND al.application_id=@applicationId
    LEFT JOIN opportunity_application_form_surfaces ol
      ON ol.surface_id=s.id AND ol.opportunity_id=@sourceOpportunityId
    LEFT JOIN job_postings jp ON jp.id=s.job_posting_id
    LEFT JOIN posting_venues pv ON pv.id=jp.posting_venue_id
    LEFT JOIN posting_platforms pp ON pp.id=pv.posting_platform_id
    WHERE (al.application_id IS NOT NULL OR ol.opportunity_id IS NOT NULL)
      AND (@primaryPostingId IS NULL OR s.job_posting_id=@primaryPostingId)
    ORDER BY CASE WHEN s.job_posting_id=@primaryPostingId THEN 0 ELSE 1 END,s.id
  `).all({
    applicationId,
    sourceOpportunityId: application.source_opportunity_id || null,
    primaryPostingId: application.primary_job_posting_id || null
  });
  return surfaces.map((surface) => {
    const selection = tableExists(db, 'application_form_revision_selections')
      ? db.prepare('SELECT * FROM application_form_revision_selections WHERE surface_id=? ORDER BY id DESC LIMIT 1').get(surface.id)
      : null;
    const selectedRevisionId = selection && (selection.revision_id || selection.selected_revision_id);
    const revision = selectedRevisionId
      ? db.prepare('SELECT * FROM application_form_revisions WHERE id=? AND surface_id=?').get(selectedRevisionId, surface.id)
      : db.prepare('SELECT * FROM application_form_revisions WHERE surface_id=? ORDER BY datetime(observed_at) DESC,id DESC LIMIT 1').get(surface.id);
    if (!revision) return { ...surface, coverage_state: 'unknown', revision_id: null, step_count: 0, field_count: 0 };
    const coverage = db.prepare('SELECT slug,label FROM application_form_coverage_states WHERE id=?').get(revision.coverage_state_id) || { slug: 'unknown', label: 'Unknown' };
    const capture = tableExists(db, 'application_form_capture_methods')
      ? db.prepare('SELECT slug,label FROM application_form_capture_methods WHERE id=?').get(revision.capture_method_id) || null
      : null;
    const review = db.prepare(`
      SELECT rr.id,d.slug AS decision,rr.reviewed_by,rr.reviewed_at
      FROM application_form_revision_reviews rr
      JOIN application_form_review_decisions d ON d.id=rr.decision_id
      WHERE rr.revision_id=? ORDER BY rr.id DESC LIMIT 1
    `).get(revision.id) || null;
    const stepCount = tableExists(db, 'application_form_steps')
      ? db.prepare('SELECT count(*) AS count FROM application_form_steps WHERE revision_id=?').get(revision.id).count
      : 0;
    const fieldCount = tableExists(db, 'application_form_fields')
      ? db.prepare('SELECT count(*) AS count FROM application_form_fields WHERE revision_id=?').get(revision.id).count
      : 0;
    return {
      ...surface,
      revision_id: revision.id,
      observed_at: revision.observed_at,
      observation_sha256: revision.observation_sha256,
      coverage_state: coverage.slug,
      coverage_label: coverage.label,
      discovery_method: capture?.slug || null,
      method_label: capture?.label || null,
      review_decision: review?.decision || 'unreviewed',
      reviewed_by: review?.reviewed_by || null,
      reviewed_at: review?.reviewed_at || null,
      step_count: stepCount,
      field_count: fieldCount,
      known_unobserved_step_count: Number(revision.known_unobserved_step_count || 0),
      possible_unobserved_branches: Boolean(revision.possible_unobserved_branches),
      pre_submit_boundary_observed: revision.pre_submit_boundary_observed === null || revision.pre_submit_boundary_observed === undefined
        ? null : Boolean(revision.pre_submit_boundary_observed)
    };
  });
}

function readV05ApplicationQuestions(db, _applicationId, materialGroups = []) {
  const revisionIds = readV05ApplicationSurveys(db, _applicationId).map((survey) => survey.revision_id).filter(Boolean);
  if (!revisionIds.length || !tableExists(db, 'application_form_fields')) return [];
  const placeholders = revisionIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT f.id,f.revision_id,f.step_id,f.position,f.provider_field_key,f.label,f.help_text,
      f.profile_information_field_id,ik.slug AS input_kind,req.slug AS requiredness,
      sens.slug AS sensitivity,obs.slug AS observation_state,pif.slug AS information_field_slug,
      r.surface_id,s.job_posting_id,r.observed_at
    FROM application_form_fields f
    JOIN application_form_revisions r ON r.id=f.revision_id
    JOIN application_form_surfaces s ON s.id=r.surface_id
    JOIN application_form_input_kinds ik ON ik.id=f.input_kind_id
    JOIN information_requiredness_levels req ON req.id=f.requiredness_id
    JOIN information_sensitivity_levels sens ON sens.id=f.sensitivity_level_id
    JOIN application_form_observation_states obs ON obs.id=f.observation_state_id
    LEFT JOIN profile_information_fields pif ON pif.id=f.profile_information_field_id
    WHERE f.revision_id IN (${placeholders}) ORDER BY s.job_posting_id,f.step_id,f.position,f.id
  `).all(...revisionIds).map((field) => {
    const group = materialGroups.find((candidate) => candidate.kind === 'form-answer' && candidate.form_field_id === field.id);
    const selected = group?.revisions.find((revision) => revision.is_selected) || null;
    const sensitive = isProtectedApplicationField(field);
    return {
      ...field,
      prompt_label: field.label,
      is_sensitive: sensitive,
      answer_state: group?.revisions.length ? 'drafted' : 'unanswered',
      answer_review_decision: selected?.latest_review_decision || 'unanswered',
      answer_is_selected: Boolean(selected)
    };
  });
}

function readV05FormFieldDescriptor(db, fieldId) {
  if (!tableExists(db, 'application_form_fields')) return null;
  return db.prepare(`
    SELECT f.id,f.provider_field_key,f.label,f.help_text,
      s.slug AS sensitivity,ik.slug AS input_kind,pif.slug AS information_field_slug
    FROM application_form_fields f
    JOIN information_sensitivity_levels s ON s.id=f.sensitivity_level_id
    JOIN application_form_input_kinds ik ON ik.id=f.input_kind_id
    LEFT JOIN profile_information_fields pif ON pif.id=f.profile_information_field_id
    WHERE f.id=?
  `).get(fieldId) || null;
}

function listMissingProfileSignals(db, applicationIds) {
  if (!applicationIds.length || !tableExists(db, 'application_information_request_current')) return new Map();
  const placeholders = applicationIds.map(() => '?').join(',');
  const applications = db.prepare(`
    SELECT id,source_opportunity_id,primary_job_posting_id FROM applications WHERE id IN (${placeholders})
  `).all(...applicationIds);
  const rows = applications.map((application) => summarizeApplicationInformationRequests(
    application.id,
    readApplicationInformationRequests(db, application)
  )).filter((summary) => summary.has_confirmed_missing);
  return new Map(rows.map((row) => [row.application_id, row]));
}

function listPipelineItems(filters = {}) {
  const applications = listApplications(filters, { scope: 'pipeline', pipeline: true });
  const opportunities = listOpportunities(filters, { pipeline: true }).map((row) => ({
    ...row,
    posting_count: row.primary_job_posting_id ? 1 : 0,
    workflow_stage: 'prospective',
    package_status: null,
    latest_activity_at: row.last_seen_at || row.updated_at || row.created_at,
    latest_activity_kind: `Opportunity ${formatToken(row.state)}`
  }));
  return [...applications, ...opportunities];
}

function sortPipelineItems(items, sort, dir) {
  return sortApplications(items, sort, dir);
}

module.exports = {
  listApplications,
  readApplicationWorkspace,
  readApplicationMaterial,
  readApplicationQuestion,
  listPipelineItems,
  sortPipelineItems
};
