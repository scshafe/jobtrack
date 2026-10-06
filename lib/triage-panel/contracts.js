'use strict';

// Contracts for the triage panel. The request is digest-pinned to an immutable
// opportunity snapshot, each panellist returns a verdict over the dimensions it
// was asked to judge, and the terminal contract is the shape a triage row can
// be written from.

const { DIMENSION_KEYS, HARD_BLOCKERS, DECISIONS, RUBRIC_VERSION } = require('./rubric');

const PANEL_REQUEST_CONTRACT = 'jobtrack-triage-panel-request.v1';
const VERDICT_CONTRACT = 'jobtrack-triage-panel-verdict.v1';
const OUTCOME_CONTRACT = 'jobtrack-triage-panel-outcome.v1';
const COMPOSITE_INPUT_CONTRACT = 'pipeline-node-input.v1';

const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

class TriageContractIssue extends Error {
  constructor(message) {
    super(message);
    this.name = 'TriageContractIssue';
    this.code = 'INVALID_TRIAGE_CONTRACT';
  }
}

function bad(path, message) {
  throw new TriageContractIssue(`${path} ${message}`);
}

function plain(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) bad(path, 'must be an object');
  return value;
}

function text(value, path, max) {
  if (typeof value !== 'string' || !value.length || value.length > max) {
    bad(path, `must be a 1..${max} character string`);
  }
  if (CONTROL_CHARACTERS.test(value)) bad(path, 'must not contain control characters');
  return value;
}

function id(value, path) {
  text(value, path, 200);
  if (!IDENTIFIER.test(value)) bad(path, 'must be a stable identifier');
  return value;
}

function sha256(value, path) {
  if (typeof value !== 'string' || !SHA256.test(value)) bad(path, 'must be a lowercase SHA-256 digest');
  return value;
}

function score(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    bad(path, 'must be a number from 0 to 100');
  }
  return value;
}

function validatePanelRequest(value) {
  const root = plain(value, 'request');
  for (const key of ['schemaVersion', 'requestId', 'opportunityId', 'snapshotId',
    'snapshotDigest', 'rubricVersion', 'posting', 'panel', 'execution', 'effects']) {
    if (root[key] === undefined) bad(`request.${key}`, 'is required');
  }
  if (root.schemaVersion !== PANEL_REQUEST_CONTRACT) bad('request.schemaVersion', `must equal ${PANEL_REQUEST_CONTRACT}`);
  id(root.requestId, 'request.requestId');
  if (!Number.isInteger(root.opportunityId) || root.opportunityId < 1) bad('request.opportunityId', 'must be a positive integer');
  if (!Number.isInteger(root.snapshotId) || root.snapshotId < 1) bad('request.snapshotId', 'must be a positive integer');
  // The snapshot digest is what closes the read/write race: a triage row must
  // bind to the exact bytes the panel judged, not to whatever is latest when it
  // finally writes.
  sha256(root.snapshotDigest, 'request.snapshotDigest');
  if (root.rubricVersion !== RUBRIC_VERSION) bad('request.rubricVersion', `must equal ${RUBRIC_VERSION}`);

  const posting = plain(root.posting, 'request.posting');
  for (const key of ['title', 'body']) {
    if (posting[key] === undefined) bad(`request.posting.${key}`, 'is required');
  }
  text(posting.title, 'request.posting.title', 500);
  text(posting.body, 'request.posting.body', 40_000);
  if (posting.company !== undefined) text(posting.company, 'request.posting.company', 300);
  if (posting.location !== undefined) text(posting.location, 'request.posting.location', 300);
  if (posting.url !== undefined) text(posting.url, 'request.posting.url', 2000);

  const panel = root.panel;
  if (!Array.isArray(panel) || panel.length < 1 || panel.length > 16) {
    bad('request.panel', 'must list 1 to 16 panellists');
  }
  panel.forEach((entry, index) => {
    const member = plain(entry, `request.panel[${index}]`);
    id(member.panellistId, `request.panel[${index}].panellistId`);
    sha256(member.personaDigest, `request.panel[${index}].personaDigest`);
    sha256(member.stackDigest, `request.panel[${index}].stackDigest`);
    if (!Array.isArray(member.dimensions) || !member.dimensions.length) {
      bad(`request.panel[${index}].dimensions`, 'must name at least one dimension');
    }
    for (const key of member.dimensions) {
      if (!DIMENSION_KEYS.includes(key)) bad(`request.panel[${index}].dimensions`, `has unknown dimension ${key}`);
    }
  });

  const execution = plain(root.execution, 'request.execution');
  if (execution.kind !== 'standalone_out_of_process') bad('request.execution.kind', 'must equal standalone_out_of_process');
  if (execution.toolAccess !== 'none') bad('request.execution.toolAccess', 'must equal none');
  if (execution.credentialAccess !== 'none') bad('request.execution.credentialAccess', 'must equal none');
  // Unlike the draft runner this may reach a model endpoint, but only a
  // local one: a keyless endpoint is what lets credentialAccess stay none.
  if (!['none', 'local_model_endpoint'].includes(execution.networkAccess)) {
    bad('request.execution.networkAccess', 'must equal none or local_model_endpoint');
  }

  const effects = plain(root.effects, 'request.effects');
  for (const key of ['storeWrite', 'send', 'applicationSubmit']) {
    if (effects[key] !== false) bad(`request.effects.${key}`, 'must equal false');
  }
  return root;
}

// One panellist's answer. Abstention is represented by omitting a dimension,
// never by a sentinel score, so an abstention can never be averaged.
function validateVerdict(value) {
  const root = plain(value, 'verdict');
  id(root.panellistId, 'verdict.panellistId');
  const scores = plain(root.dimensionScores, 'verdict.dimensionScores');
  for (const [key, entry] of Object.entries(scores)) {
    if (!DIMENSION_KEYS.includes(key)) bad('verdict.dimensionScores', `has unknown dimension ${key}`);
    const judgement = plain(entry, `verdict.dimensionScores.${key}`);
    score(judgement.score, `verdict.dimensionScores.${key}.score`);
    text(judgement.rationale, `verdict.dimensionScores.${key}.rationale`, 400);
  }
  if (!Array.isArray(root.hardBlockers)) bad('verdict.hardBlockers', 'must be an array');
  if (root.hardBlockers.length > 8) bad('verdict.hardBlockers', 'must contain at most 8 entries');
  for (const blocker of root.hardBlockers) {
    if (!HARD_BLOCKERS.includes(blocker)) bad('verdict.hardBlockers', `has unknown blocker ${blocker}`);
  }
  if (!Array.isArray(root.abstained)) bad('verdict.abstained', 'must be an array');
  for (const key of root.abstained) {
    if (!DIMENSION_KEYS.includes(key)) bad('verdict.abstained', `has unknown dimension ${key}`);
  }
  text(root.summary, 'verdict.summary', 600);
  return root;
}

function validateOutcome(value) {
  const root = plain(value, 'outcome');
  if (root.schemaVersion !== OUTCOME_CONTRACT) bad('outcome.schemaVersion', `must equal ${OUTCOME_CONTRACT}`);
  if (!DECISIONS.includes(root.decision)) bad('outcome.decision', 'must be a known triage decision');
  if (root.score !== null) score(root.score, 'outcome.score');
  if (typeof root.scoreCoverage !== 'number' || root.scoreCoverage < 0 || root.scoreCoverage > 1) {
    bad('outcome.scoreCoverage', 'must be a number from 0 to 1');
  }
  // The triage table refuses a score without its coverage and vice versa, so a
  // scoreless outcome must carry no coverage claim at all.
  if (root.score === null && root.scoreCoverage !== 0) {
    bad('outcome.scoreCoverage', 'must be 0 when no dimension was scored');
  }
  plain(root.dimensions, 'outcome.dimensions');
  for (const [key, entry] of Object.entries(root.dimensions)) {
    if (!DIMENSION_KEYS.includes(key)) bad('outcome.dimensions', `has unknown dimension ${key}`);
    score(entry.score, `outcome.dimensions.${key}.score`);
    if (!Number.isInteger(entry.panellists) || entry.panellists < 1) {
      bad(`outcome.dimensions.${key}.panellists`, 'must be a positive integer');
    }
  }
  if (!Array.isArray(root.hardBlockers)) bad('outcome.hardBlockers', 'must be an array');
  if (!Array.isArray(root.verdicts) || !root.verdicts.length) bad('outcome.verdicts', 'must retain every panellist verdict');
  text(root.rationale, 'outcome.rationale', 4000);
  sha256(root.snapshotDigest, 'outcome.snapshotDigest');
  if (root.rubricVersion !== RUBRIC_VERSION) bad('outcome.rubricVersion', `must equal ${RUBRIC_VERSION}`);
  return root;
}

const VALIDATORS = new Map([
  [PANEL_REQUEST_CONTRACT, validatePanelRequest],
  [VERDICT_CONTRACT, validateVerdict],
  [OUTCOME_CONTRACT, validateOutcome]
]);

function createTriagePanelContracts() {
  return Object.freeze({
    knows: (contractId) => VALIDATORS.has(contractId) || contractId === COMPOSITE_INPUT_CONTRACT,
    validate(contractId, value) {
      if (contractId === COMPOSITE_INPUT_CONTRACT) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          return { ok: false, issues: [{ message: 'composite stage input must be an object of named slots' }] };
        }
        return { ok: true, value };
      }
      const validator = VALIDATORS.get(contractId);
      if (!validator) return { ok: false, issues: [{ message: `unknown contract ${contractId}` }] };
      try { return { ok: true, value: validator(value) }; }
      catch (error) { return { ok: false, issues: [{ message: String(error.message || error) }] }; }
    }
  });
}

module.exports = Object.freeze({
  COMPOSITE_INPUT_CONTRACT,
  OUTCOME_CONTRACT,
  PANEL_REQUEST_CONTRACT,
  TriageContractIssue,
  VERDICT_CONTRACT,
  createTriagePanelContracts,
  validateOutcome,
  validatePanelRequest,
  validateVerdict
});
