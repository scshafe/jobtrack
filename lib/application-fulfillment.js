'use strict';

// application-fulfillment.js — the FULFILLMENT PLAN engine.
//
// Readiness answers one question: "may this application build a package?" —
// a single verdict with blockers. This module answers the question an agent
// (or operator) preparing an application actually has: "what is the state of
// EVERY required input, what can I work on RIGHT NOW, and what is genuinely
// waiting on something else?"
//
// Design rules (Cole's directive, 2026-08-04):
//   * Materials and answers are INDEPENDENT unless a dependency is DECLARED.
//     A missing protected answer never blocks generating the resume; an
//     unresolved info request never blocks drafting the cover letter. The
//     only inter-item edges are explicit `dependsOnFieldKey` declarations in
//     the form observation (multi-part questions whose answers follow from
//     one another).
//   * Stage gates (managed plan, approved assessment, attested form coverage)
//     are PLAN-LEVEL facts, listed once — not smeared across items as fake
//     per-item blockers.
//   * Blocking work only blocks the NEXT STEP (readiness -> package ->
//     submission), never sibling generation. `ready` here is readiness's own
//     verdict, computed from the same evaluation — one classifier, two views.
//
// Every item carries a `nextAction` — the exact CLI move that advances it —
// so automation loops can walk `actionable` items without re-deriving the
// ceremony.
//
// This module only READS (via getApplicationReadiness + two small queries);
// it never writes.

const { getApplicationReadiness } = require('./application-materials');

/** Blocker codes that mean "a human must act" — never agent-actionable. */
const AWAITING_HUMAN_CODES = new Set([
  'PROTECTED_RESPONSE_REQUIRES_HUMAN',
  'PROTECTED_RESPONSE_NOT_HUMAN',
  'FORM_RESPONSE_NOT_RECORDED'
]);

/** Plan-level stage gates, matched by blocker code prefix/name. */
const STAGE_GATES = [
  {
    key: 'managed-plan',
    label: 'Managed preparation plan',
    codes: ['LEGACY_PREPARATION_NOT_MANAGED', 'PREPARATION_PLAN_MISSING']
  },
  {
    key: 'assessment',
    label: 'Assessment approved',
    codes: ['ASSESSMENT_MISSING', 'ASSESSMENT_NOT_APPROVED', 'ASSESSMENT_EVIDENCE_STALE']
  },
  {
    key: 'form-coverage',
    label: 'Form observed, reviewed, and coverage attested',
    codes: [
      'FORM_NOT_CAPTURED', 'FORM_NOT_REVIEWED', 'FORM_COVERAGE_NOT_ATTESTED',
      'FORM_COVERAGE_INCOMPLETE', 'FORM_REVISION_PENDING', 'FORM_STATE_STALE',
      'FORM_UNCERTAINTY_UNACCEPTED'
    ]
  }
];

const KIND_ITEMS = [
  { kind: 'resume', label: 'Tailored resume', match: /resume/i },
  { kind: 'cover-letter', label: 'Tailored cover letter', match: /cover[\s-]*letter/i }
];

/**
 * Build the fulfillment plan for an application.
 * @param {import('better-sqlite3').Database} db
 * @param {number} applicationId
 */
function buildFulfillmentPlan(db, applicationId) {
  // The internal (unsanitized) evaluation: the public projection redacts
  // protected fields entirely, but the plan must still SCHEDULE them — so we
  // read the full state and apply our own conservative redaction below:
  // protected items keep their provider key and state, never their label or
  // any content.
  const readiness = getApplicationReadiness(db, applicationId, { includeProtectedContent: true });
  const blockers = readiness.blockers || [];

  const gateCodes = new Set(STAGE_GATES.flatMap((gate) => gate.codes));
  const gates = STAGE_GATES.map((gate) => {
    const hits = blockers.filter((item) => gate.codes.includes(item.code));
    return { key: gate.key, label: gate.label, satisfied: hits.length === 0, blockers: hits };
  });
  const openGateKeys = gates.filter((gate) => !gate.satisfied).map((gate) => gate.key);

  // Non-gate blockers indexed to the item they concern.
  const itemBlockers = blockers.filter((item) => !gateCodes.has(item.code));
  const byFieldId = new Map();
  for (const item of itemBlockers) {
    if (item.formFieldId) {
      if (!byFieldId.has(item.formFieldId)) byFieldId.set(item.formFieldId, []);
      byFieldId.get(item.formFieldId).push(item);
    }
  }
  const kindLevel = (match) => itemBlockers.filter(
    (item) => !item.formFieldId && match.test(String(item.message || ''))
  );

  // Declared dependencies (the ONLY inter-item edges).
  const dependencyRows = db.prepare(`
    SELECT f.id, f.depends_on_field_key FROM application_form_fields f
    WHERE f.depends_on_field_key IS NOT NULL AND f.revision_id=(
      SELECT sel.revision_id FROM application_form_revision_selections sel
      JOIN application_application_form_surfaces link ON link.surface_id=sel.surface_id
      WHERE link.application_id=? ORDER BY sel.id DESC LIMIT 1
    )
  `).all(applicationId);
  const dependsOnKeyByFieldId = new Map(dependencyRows.map((row) => [row.id, row.depends_on_field_key]));

  const fields = (readiness.form?.fields || []);
  const fieldByKey = new Map(fields.map((field) => [field.provider_field_key, field]));

  /** @type {any[]} */
  const items = [];

  for (const definition of KIND_ITEMS) {
    const hits = kindLevel(definition.match);
    items.push(classify({
      type: 'material',
      key: definition.kind,
      label: definition.label,
      required: true,
      protectedField: false,
      fulfillment: definition.kind,
      blockers: hits,
      openGateKeys
    }));
  }

  for (const field of fields) {
    const hits = byFieldId.get(field.id) || [];
    // Protected fields have their provider keys sanitized system-wide; the
    // stable address for them is the field id (exactly how the CLI's
    // --form-field-id flag addresses them).
    items.push(classify({
      type: 'form-field',
      key: field.provider_field_key || `field-${field.id}`,
      formFieldId: field.id,
      label: field.protected ? '[protected field]' : field.label,
      required: ['required', 'conditional'].includes(String(field.requiredness || '').toLowerCase()),
      protectedField: Boolean(field.protected),
      fulfillment: field.fulfillment || 'unknown',
      blockers: hits,
      openGateKeys,
      dependsOnFieldKey: dependsOnKeyByFieldId.get(field.id) || null
    }));
  }

  // Second pass: declared dependencies. A field whose declared parent is not
  // fulfilled is blocked-by-dependency (unless itself already fulfilled).
  const byKey = new Map(items.map((item) => [item.key, item]));
  for (const item of items) {
    if (!item.dependsOnFieldKey || item.state === 'fulfilled') continue;
    const parent = byKey.get(item.dependsOnFieldKey) || fieldByKey.get(item.dependsOnFieldKey);
    const parentItem = parent && byKey.get(parent.provider_field_key || parent.key);
    if (parentItem && parentItem.state !== 'fulfilled') {
      item.state = 'blocked-by-dependency';
      item.nextAction = `Fulfill “${parentItem.label}” (${parentItem.key}) first — this answer follows from it.`;
    }
  }

  const summary = {
    fulfilled: items.filter((item) => item.state === 'fulfilled').length,
    actionable: items.filter((item) => item.state === 'actionable').length,
    awaitingHuman: items.filter((item) => item.state === 'awaiting-human').length,
    blockedByDependency: items.filter((item) => item.state === 'blocked-by-dependency').length,
    optionalOpen: items.filter((item) => item.state === 'optional-open').length,
    openGates: openGateKeys
  };

  return {
    applicationId,
    ready: readiness.ready === true,
    readinessSha256: readiness.readinessSha256,
    formStateSha256: readiness.form?.stateSha256 || null,
    gates,
    items,
    summary
  };
}

/** Classify one item from its blockers + metadata. */
function classify({ type, key, formFieldId, label, required, protectedField, fulfillment, blockers, openGateKeys, dependsOnFieldKey = null }) {
  let state;
  if (blockers.length === 0) {
    state = required ? 'fulfilled' : 'optional-open';
    // An optional field with no blockers and no selection is simply open; a
    // required one with no blockers is satisfied by definition of readiness.
  } else if (blockers.some((item) => AWAITING_HUMAN_CODES.has(item.code))) {
    state = 'awaiting-human';
  } else {
    state = 'actionable';
  }
  return {
    type,
    key,
    ...(formFieldId ? { formFieldId } : {}),
    label,
    required,
    protected: protectedField,
    fulfillment,
    state,
    gatedBy: openGateKeys,
    dependsOnFieldKey,
    blockers: blockers.map((item) => ({ code: item.code, message: item.message })),
    nextAction: nextActionFor({ state, fulfillment, formFieldId, key })
  };
}

/** The exact CLI move that advances an item, by state and fulfillment kind. */
function nextActionFor({ state, fulfillment, formFieldId, key }) {
  if (state === 'fulfilled') return null;
  if (state === 'optional-open') {
    return formFieldId
      ? `Optional — answer via application-material context/draft --kind form-answer --form-field-id ${formFieldId} if desired.`
      : null;
  }
  if (state === 'awaiting-human') {
    if (fulfillment === 'protected-human-only') {
      return `Human authors the answer: application-material draft --kind form-answer --form-field-id ${formFieldId} --authorship human --authored-by <human> …, then review + select.`;
    }
    return `Human resolves the field: application-material resolve-field --form-field-id ${formFieldId} … (non-generated response).`;
  }
  switch (fulfillment) {
    case 'resume':
    case 'cover-letter':
      return `application-material context --kind ${fulfillment} … → draft (rough → final) → render → review --render-id → select.`;
    case 'generated-answer':
      return `application-material context --kind form-answer --form-field-id ${formFieldId} … → draft → review → select.`;
    case 'profile-information':
      return `profile info-request mark/assess for this field (${key}), or resolve-field with pinned evidence.`;
    default:
      return `Resolve blockers for ${key} (see blockers).`;
  }
}

module.exports = { buildFulfillmentPlan, AWAITING_HUMAN_CODES, STAGE_GATES };
