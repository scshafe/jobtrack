'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  ApplicationStrategyError,
  bindApplicationStrategyWorkResult,
  buildApplicationStrategyContext,
  getApplicationStrategyReadModel,
  getApplicationStrategyRevision,
  getApplicationStrategyStatus,
  getCurrentRoutingPolicy,
  importApplicationStrategyPlan,
  importRoutingPolicy,
  issueApplicationStrategyWork,
  listApplicationStrategyQueue,
  recordApplicationStrategyWorkResult,
  reviewApplicationStrategyPlan,
  reviewApplicationStrategyWorkResult,
  reviewRoutingPolicy,
  selectApplicationStrategyPlan,
  selectRoutingPolicy
} = require('./application-strategy');

const MAX_STRATEGY_INPUT_BYTES = 2 * 1024 * 1024;
const SELECTOR_FLAGS = Object.freeze([
  'artifactIds', 'snapshotIds', 'materialRevisionIds', 'emailMessageRefIds', 'interviewIds',
  'profileEntryIds', 'storyUseIds'
]);
const STRATEGY_FLAG_SCHEMAS = Object.freeze({
  'policy import': ['input', 'importedBy', 'idempotencyKey'],
  'policy review': [
    'policyRevisionId', 'decision', 'reviewedBy', 'expectedReviewId', 'notes',
    'reviewedAt', 'idempotencyKey'
  ],
  'policy select': [
    'policyRevisionId', 'selectedBy', 'expectedCurrentPolicyRevisionId', 'selectedAt',
    'idempotencyKey'
  ],
  'policy show': [],
  context: ['applicationId', 'id', ...SELECTOR_FLAGS],
  'plan import': ['input', 'parentRevisionId', 'idempotencyKey', ...SELECTOR_FLAGS],
  'plan review': [
    'strategyRevisionId', 'decision', 'reviewedBy', 'expectedReviewId', 'notes',
    'reviewedAt', 'idempotencyKey'
  ],
  'plan select': [
    'strategyRevisionId', 'selectedBy', 'expectedCurrentStrategyRevisionId', 'selectedAt',
    'idempotencyKey'
  ],
  'plan show': ['strategyRevisionId', 'applicationId', 'id'],
  queue: ['applicationId', 'state', 'capability'],
  status: ['applicationId', 'id'],
  show: ['applicationId', 'id'],
  'work issue': [
    'workItemId', 'issuedBy', 'expectedSourceStateSha256', 'idempotencyKey'
  ],
  'work record': ['input', 'idempotencyKey'],
  'work review': [
    'resultId', 'decision', 'reviewedBy', 'reviewedAs', 'notes', 'reviewedAt', 'idempotencyKey'
  ],
  'work bind': [
    'resultId', 'applicationId', 'artifactId', 'assessmentId', 'materialRevisionId',
    'emailReplyProposalId', 'interviewPrepAnalysisId', 'materialRenderId',
    'expectedCurrentSourceStateSha256', 'boundBy', 'reason', 'boundAt', 'idempotencyKey'
  ]
});

function strategyAction(args) {
  const first = args[0] || 'queue';
  if (['policy', 'plan', 'work'].includes(first)) return `${first} ${args[1] || ''}`.trim();
  return first;
}

function assertApplicationStrategyCommandFlags(args, flags) {
  const action = strategyAction(args);
  const schema = STRATEGY_FLAG_SCHEMAS[action];
  if (!schema) throw new ApplicationStrategyError('UNKNOWN_COMMAND', `Unknown strategy action: ${action}`);
  const allowed = new Set(schema);
  const unknown = Object.keys(flags).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new ApplicationStrategyError(
      'INVALID_ARGUMENT',
      `Unknown flag(s) for strategy ${action}: ${unknown.sort().map(toFlag).join(', ')}`
    );
  }
}

function runApplicationStrategyCommand(db, args, flags = {}) {
  const action = strategyAction(args);
  assertApplicationStrategyCommandFlags(args, flags);
  const expectedArgs = ['policy', 'plan', 'work'].includes(args[0]) ? 2 : 1;
  if (args.length > expectedArgs) {
    throw new ApplicationStrategyError('INVALID_ARGUMENT', `Too many positional arguments for strategy ${action}`);
  }

  if (action === 'policy import') {
    return importRoutingPolicy(db, readJsonFile(flags.input), {
      importedBy: requiredText(flags.importedBy, '--imported-by'),
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key')
    });
  }
  if (action === 'policy review') {
    return reviewRoutingPolicy(db, {
      policyRevisionId: requiredId(flags.policyRevisionId, 'policy revision id'),
      decision: requiredText(flags.decision, '--decision'),
      reviewedBy: requiredText(flags.reviewedBy, '--reviewed-by'),
      expectedReviewId: requiredExpected(flags.expectedReviewId, '--expected-review-id'),
      notes: flags.notes,
      reviewedAt: flags.reviewedAt,
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key')
    });
  }
  if (action === 'policy select') {
    return selectRoutingPolicy(db, {
      policyRevisionId: requiredId(flags.policyRevisionId, 'policy revision id'),
      selectedBy: requiredText(flags.selectedBy, '--selected-by'),
      expectedCurrentPolicyRevisionId: requiredExpected(
        flags.expectedCurrentPolicyRevisionId,
        '--expected-current-policy-revision-id'
      ),
      selectedAt: flags.selectedAt,
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key')
    });
  }
  if (action === 'policy show') return { policy: getCurrentRoutingPolicy(db) };
  if (action === 'context') {
    return {
      context: buildApplicationStrategyContext(
        db,
        requiredId(flags.applicationId || flags.id, 'application id'),
        selectedFlags(flags)
      )
    };
  }
  if (action === 'plan import') {
    return importApplicationStrategyPlan(db, readJsonFile(flags.input), {
      parentRevisionId: flags.parentRevisionId,
      selectors: selectedFlags(flags, true),
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key')
    });
  }
  if (action === 'plan review') {
    return reviewApplicationStrategyPlan(db, {
      strategyRevisionId: requiredId(flags.strategyRevisionId, 'strategy revision id'),
      decision: requiredText(flags.decision, '--decision'),
      reviewedBy: requiredText(flags.reviewedBy, '--reviewed-by'),
      expectedReviewId: requiredExpected(flags.expectedReviewId, '--expected-review-id'),
      notes: flags.notes,
      reviewedAt: flags.reviewedAt,
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key')
    });
  }
  if (action === 'plan select') {
    return selectApplicationStrategyPlan(db, {
      strategyRevisionId: requiredId(flags.strategyRevisionId, 'strategy revision id'),
      selectedBy: requiredText(flags.selectedBy, '--selected-by'),
      expectedCurrentStrategyRevisionId: requiredExpected(
        flags.expectedCurrentStrategyRevisionId,
        '--expected-current-strategy-revision-id'
      ),
      selectedAt: flags.selectedAt,
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key')
    });
  }
  if (action === 'plan show') {
    return getApplicationStrategyRevision(
      db,
      requiredId(flags.strategyRevisionId || flags.id, 'strategy revision id'),
      optionalId(flags.applicationId, 'application id')
    );
  }
  if (action === 'queue') {
    return listApplicationStrategyQueue(db, {
      ...(flags.applicationId ? { applicationId: requiredId(flags.applicationId, 'application id') } : {}),
      ...(flags.state ? { state: flags.state } : {}),
      ...(flags.capability ? { capability: flags.capability } : {})
    });
  }
  if (action === 'status') {
    return getApplicationStrategyStatus(db, requiredId(flags.applicationId || flags.id, 'application id'));
  }
  if (action === 'show') {
    return getApplicationStrategyReadModel(db, requiredId(flags.applicationId || flags.id, 'application id'));
  }
  if (action === 'work issue') {
    return issueApplicationStrategyWork(db, {
      workItemId: requiredId(flags.workItemId, 'work item id'),
      issuedBy: requiredText(flags.issuedBy, '--issued-by'),
      expectedSourceStateSha256: requiredText(flags.expectedSourceStateSha256, '--expected-source-state-sha256'),
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key')
    });
  }
  if (action === 'work record') {
    return recordApplicationStrategyWorkResult(db, readJsonFile(flags.input), {
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key')
    });
  }
  if (action === 'work review') {
    return reviewApplicationStrategyWorkResult(db, {
      resultId: requiredId(flags.resultId, 'work result id'),
      decision: requiredText(flags.decision, '--decision'),
      reviewedBy: requiredText(flags.reviewedBy, '--reviewed-by'),
      reviewedAs: requiredText(flags.reviewedAs, '--reviewed-as'),
      notes: flags.notes,
      reviewedAt: flags.reviewedAt,
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key')
    });
  }
  if (action === 'work bind') {
    return bindApplicationStrategyWorkResult(db, {
      resultId: requiredId(flags.resultId, 'work result id'),
      applicationId: requiredId(flags.applicationId, 'application id'),
      ...(flags.artifactId ? { artifactId: flags.artifactId } : {}),
      ...(flags.assessmentId ? { assessmentId: flags.assessmentId } : {}),
      ...(flags.materialRevisionId ? { materialRevisionId: flags.materialRevisionId } : {}),
      ...(flags.emailReplyProposalId ? { emailReplyProposalId: flags.emailReplyProposalId } : {}),
      ...(flags.interviewPrepAnalysisId ? { interviewPrepAnalysisId: flags.interviewPrepAnalysisId } : {}),
      ...(flags.materialRenderId ? { materialRenderId: flags.materialRenderId } : {}),
      expectedCurrentSourceStateSha256: requiredText(
        flags.expectedCurrentSourceStateSha256,
        '--expected-current-source-state-sha256'
      ),
      boundBy: requiredText(flags.boundBy, '--bound-by'),
      reason: requiredText(flags.reason, '--reason'),
      boundAt: flags.boundAt,
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key')
    });
  }
  throw new ApplicationStrategyError('UNKNOWN_COMMAND', `Unknown strategy action: ${action}`);
}

function selectedFlags(flags, forceAll = false) {
  const result = {};
  for (const key of SELECTOR_FLAGS) {
    if (forceAll || Object.prototype.hasOwnProperty.call(flags, key)) result[key] = flags[key] || '';
  }
  return result;
}

function readJsonFile(value) {
  const file = path.resolve(requiredText(value, '--input'));
  let stat;
  try { stat = fs.statSync(file); }
  catch { throw new ApplicationStrategyError('INVALID_INPUT', `Input file does not exist: ${file}`); }
  if (!stat.isFile()) throw new ApplicationStrategyError('INVALID_INPUT', '--input must identify a regular JSON file');
  if (stat.size > MAX_STRATEGY_INPUT_BYTES) {
    throw new ApplicationStrategyError('INPUT_TOO_LARGE', `Strategy input exceeds ${MAX_STRATEGY_INPUT_BYTES} bytes`);
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new ApplicationStrategyError('INVALID_JSON', '--input must contain valid JSON'); }
}

function requiredExpected(value, label) {
  if (value === undefined || value === '') throw new ApplicationStrategyError('INVALID_ARGUMENT', `Missing required ${label}; use none when no value is current`);
  return value;
}

function requiredId(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new ApplicationStrategyError('INVALID_ARGUMENT', `${label} must be a positive integer`);
  return number;
}

function optionalId(value, label) {
  return value === undefined || value === '' ? null : requiredId(value, label);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new ApplicationStrategyError('INVALID_ARGUMENT', `Missing required ${label}`);
  return value.trim();
}

function toFlag(value) {
  return `--${value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`;
}

module.exports = {
  MAX_STRATEGY_INPUT_BYTES,
  SELECTOR_FLAGS,
  STRATEGY_FLAG_SCHEMAS,
  assertApplicationStrategyCommandFlags,
  runApplicationStrategyCommand
};
