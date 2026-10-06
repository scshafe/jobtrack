'use strict';

const fs = require('node:fs');
const {
  buildInterviewPrepContext,
  createInterviewPrepAnalysis,
  generateDeterministicPrep,
  getCurrentInterviewPrep,
  getInterviewPrepAnalysis,
  listInterviewPrepQueue,
  reviewInterviewPrepAnalysis,
  selectCurrentInterviewPrep
} = require('./interview-prep');

const MAX_ANALYSIS_BYTES = 2 * 1024 * 1024;
const FLAG_SCHEMAS = Object.freeze({
  list: ['before', 'after'],
  queue: ['before', 'after'],
  context: ['interviewId', 'id'],
  show: ['analysisId', 'interviewId', 'id'],
  current: ['interviewId', 'id'],
  generate: ['interviewId', 'id', 'generatedBy', 'idempotencyKey'],
  create: ['interviewId', 'id', 'analysisFile', 'file', 'generatedBy', 'idempotencyKey'],
  review: ['analysisId', 'decision', 'reviewedBy', 'notes', 'idempotencyKey'],
  select: ['analysisId', 'selectedBy', 'expectedCurrentAnalysisId', 'idempotencyKey']
});

function runInterviewPrepCommand(db, args, flags, context = {}) {
  const action = args[0] || 'list';
  assertFlags(flags, FLAG_SCHEMAS[action], `interview-prep ${action}`);
  if (action === 'list' || action === 'queue') {
    return { interviews: listInterviewPrepQueue(db, { before: flags.before, after: flags.after }) };
  }
  if (action === 'context') {
    return { context: buildInterviewPrepContext(db, requiredId(flags.interviewId || flags.id || args[1], 'interview id')) };
  }
  if (action === 'show') {
    if (flags.analysisId) return getInterviewPrepAnalysis(db, requiredId(flags.analysisId, 'analysis id'));
    return getCurrentInterviewPrep(db, requiredId(flags.interviewId || flags.id || args[1], 'interview id'));
  }
  if (action === 'current') {
    return getCurrentInterviewPrep(db, requiredId(flags.interviewId || flags.id || args[1], 'interview id'));
  }
  if (action === 'generate') {
    return generateDeterministicPrep(db, requiredId(flags.interviewId || flags.id || args[1], 'interview id'), {
      ...context,
      generatedBy: flags.generatedBy || context.generatedBy || 'jobtrack-deterministic',
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key')
    });
  }
  if (action === 'create') {
    const interviewId = requiredId(flags.interviewId || flags.id || args[1], 'interview id');
    const input = readAnalysisFile(flags.analysisFile || flags.file);
    if (input.interviewId !== undefined && Number(input.interviewId) !== interviewId) {
      throw new Error(`Analysis file interviewId ${input.interviewId} does not match requested interview ${interviewId}`);
    }
    return createInterviewPrepAnalysis(db, {
      ...input,
      interviewId,
      generatedBy: flags.generatedBy || input.generatedBy
    }, { ...context, idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key') });
  }
  if (action === 'review') {
    return reviewInterviewPrepAnalysis(db, {
      analysisId: requiredId(flags.analysisId, 'analysis id'),
      decision: requiredText(flags.decision, '--decision'),
      reviewedBy: requiredText(flags.reviewedBy, '--reviewed-by'),
      notes: flags.notes
    }, { ...context, idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key') });
  }
  if (action === 'select') {
    return selectCurrentInterviewPrep(db, {
      analysisId: requiredId(flags.analysisId, 'analysis id'),
      selectedBy: requiredText(flags.selectedBy, '--selected-by'),
      expectedCurrentAnalysisId: requiredText(flags.expectedCurrentAnalysisId, '--expected-current-analysis-id')
    }, { ...context, idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key') });
  }
  throw new Error(`Unknown interview-prep action: ${action}`);
}

function readAnalysisFile(file) {
  if (!file) throw new Error('Provide --analysis-file');
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`Analysis path is not a file: ${file}`);
  if (stat.size > MAX_ANALYSIS_BYTES) throw new Error(`Analysis file exceeds ${MAX_ANALYSIS_BYTES} bytes`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Analysis file is not valid JSON: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Analysis file must contain one JSON object');
  return parsed;
}

function assertFlags(flags, schema, scope) {
  if (!schema) throw new Error(`Unknown interview-prep action: ${scope.split(' ').slice(1).join(' ')}`);
  const allowed = new Set(schema);
  const invalid = Object.keys(flags).filter((key) => !allowed.has(key));
  if (invalid.length) throw new Error(`Unknown flag(s) for ${scope}: ${invalid.sort().map(toFlag).join(', ')}`);
}

function requiredId(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

function requiredText(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') throw new Error(`Missing required ${label}`);
  return String(value).trim();
}

function toFlag(value) {
  return `--${value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

module.exports = { FLAG_SCHEMAS, MAX_ANALYSIS_BYTES, runInterviewPrepCommand };
