'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ApplicationFormError,
  attestApplicationFormCoverage,
  importApplicationFormObservation,
  readApplicationFormSurface,
  readApplicationFormsForTarget,
  reviewApplicationFormRevision
} = require('./application-form');
const { isProtectedApplicationField } = require('./application-field-safety');

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const FLAGS = Object.freeze({
  import: ['input', 'importedBy', 'idempotencyKey'],
  review: ['revisionId', 'decision', 'reviewedBy', 'rationale', 'expectedCurrentRevisionId', 'expectedReviewId', 'reviewedAt', 'idempotencyKey'],
  'coverage-attest': ['revisionId', 'attestationKind', 'attestedBy', 'rationale', 'expectedAttestationId', 'attestedAt', 'idempotencyKey'],
  show: ['surfaceId', 'postingId', 'exact'],
  list: ['applicationId', 'opportunityId', 'postingId']
});

function assertApplicationFormCommandFlags(action, flags) {
  const allowed = FLAGS[action];
  if (!allowed) throw new ApplicationFormError('UNKNOWN_COMMAND', `Unknown application-form action: ${action || '(missing)'}`);
  const accepted = new Set(allowed);
  const unknown = Object.keys(flags).filter((key) => !accepted.has(key));
  if (unknown.length) {
    throw new ApplicationFormError('INVALID_ARGUMENT', `Unknown flag(s) for application-form ${action}: ${unknown.sort().map(toFlag).join(', ')}`);
  }
  return true;
}

function runApplicationFormCommand(db, args, flags) {
  if (!Array.isArray(args) || args.length !== 1) {
    throw new ApplicationFormError('INVALID_ARGUMENT', 'Use exactly one application-form action');
  }
  const action = args[0];
  assertApplicationFormCommandFlags(action, flags);
  if (action === 'import') {
    return projectPublicFormResult(importApplicationFormObservation(db, readBoundedInput(flags.input), {
      importedBy: flags.importedBy,
      idempotencyKey: flags.idempotencyKey
    }));
  }
  if (action === 'review') return projectPublicFormResult(reviewApplicationFormRevision(db, flags));
  if (action === 'coverage-attest') return projectPublicFormResult(attestApplicationFormCoverage(db, flags));
  if (action === 'show') {
    const form = readApplicationFormSurface(db, flags);
    return normalizeBoolean(flags.exact, false) ? form : projectPublicApplicationForm(form);
  }
  if (action === 'list') return { forms: readApplicationFormsForTarget(db, flags).map(projectPublicApplicationForm) };
  throw new ApplicationFormError('UNKNOWN_COMMAND', `Unknown application-form action: ${action}`);
}

function projectPublicFormResult(result) {
  return result?.form ? { ...result, form: projectPublicApplicationForm(result.form) } : result;
}

function projectPublicApplicationForm(form) {
  if (!form?.currentRevision) return form;
  let containsProtectedFields = false;
  const steps = form.currentRevision.steps.map((step) => {
    let protectedStep = false;
    const fields = step.fields.map((field) => {
      if (!isProtectedApplicationField(field)) return field;
      containsProtectedFields = true;
      protectedStep = true;
      return {
        id: field.id,
        revision_id: field.revision_id,
        step_id: field.step_id,
        position: field.position,
        input_kind: field.input_kind,
        requiredness: field.requiredness,
        sensitivity: field.sensitivity,
        observation_state: field.observation_state,
        is_repeatable: field.is_repeatable,
        optionCount: Array.isArray(field.options) ? field.options.length : 0,
        protected: true,
        label: 'Protected application field'
      };
    });
    return protectedStep ? { ...step, label: 'Protected application section', fields } : { ...step, fields };
  });
  const currentRevision = { ...form.currentRevision, steps };
  if (containsProtectedFields) {
    if (currentRevision.review) currentRevision.review = selectKeys(currentRevision.review, [
      'id', 'revision_id', 'decision_id', 'expected_review_id', 'reviewed_by', 'reviewed_at',
      'created_at', 'decision'
    ]);
    currentRevision.coverageAttestations = (currentRevision.coverageAttestations || []).map((row) => selectKeys(row, [
      'id', 'revision_id', 'attestation_kind', 'attested_by', 'expected_attestation_id',
      'attested_at', 'created_at'
    ]));
  }
  return { ...form, currentRevision, protectedPayloadRedacted: containsProtectedFields };
}

function selectKeys(value, keys) {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true' || value === '1' || value === 'yes') return true;
  if (value === false || value === 'false' || value === '0' || value === 'no') return false;
  throw new ApplicationFormError('INVALID_ARGUMENT', '--exact must be true or false');
}

function readBoundedInput(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new ApplicationFormError('INVALID_ARGUMENT', '--input is required');
  }
  const filename = path.resolve(String(value));
  let stat;
  try { stat = fs.lstatSync(filename); } catch { throw new ApplicationFormError('INVALID_ARGUMENT', `Cannot read --input: ${filename}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ApplicationFormError('INVALID_ARGUMENT', '--input must be a non-symlink regular file');
  if (stat.size > MAX_INPUT_BYTES) throw new ApplicationFormError('INVALID_ARGUMENT', `--input exceeds ${MAX_INPUT_BYTES} bytes`);
  return fs.readFileSync(filename);
}

function toFlag(key) {
  return `--${key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`;
}

module.exports = {
  assertApplicationFormCommandFlags,
  runApplicationFormCommand
};
