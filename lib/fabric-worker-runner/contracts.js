'use strict';

// The fabric worker runner's two contracts — `jobtrack-fabric-worker-request.v1`
// (what applysim's dispatcher hands the runner) and
// `jobtrack-fabric-worker-report.v1` (what the agent turn returns) — with the
// LOUD validators the runner applies on both sides of the engine. Moved out of
// the v1 runner verbatim when the engine moved to v2 (docs/V2-ENGINE-PORT.md).

const REQUEST_CONTRACT = 'jobtrack-fabric-worker-request.v1';
/** The agent harnesses a worker request may name; absent = claude (the original). */
const HARNESSES = new Set(['claude', 'codex']);
const REPORT_CONTRACT = 'jobtrack-fabric-worker-report.v1';
const PIPELINE_ID = 'jobtrack-fabric-worker';
const PIPELINE_VERSION = 1;
const STAGE = Object.freeze({ id: 'jobtrack.fabric.worker_turn', version: 1 });
const MAX_BRIEF_CHARS = 90000;
const MAX_REPORT_CHARS = 20000;
const DEFAULT_DEADLINE_MS = 8 * 60 * 1000;

class FabricWorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FabricWorkerError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// contracts
// ---------------------------------------------------------------------------

function validateWorkerRequest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FabricWorkerError('INVALID_REQUEST', 'request must be a JSON object');
  }
  const allowed = new Set(['schemaVersion', 'requestId', 'node', 'subjectKind', 'subjectId', 'instance', 'brief', 'model', 'harness', 'deadlineMs']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new FabricWorkerError('INVALID_REQUEST', `unknown request key "${key}"`);
  }
  const text = (field, min, max) => {
    const raw = value[field];
    if (typeof raw !== 'string' || raw.length < min || raw.length > max) {
      throw new FabricWorkerError('INVALID_REQUEST', `${field} must be a string of ${min}..${max} chars`);
    }
    return raw;
  };
  if (value.schemaVersion !== REQUEST_CONTRACT) {
    throw new FabricWorkerError('INVALID_REQUEST', `schemaVersion must be ${REQUEST_CONTRACT}`);
  }
  text('requestId', 8, 200);
  text('node', 3, 120);
  text('subjectKind', 3, 40);
  if (!Number.isSafeInteger(value.subjectId) || value.subjectId < 1) {
    throw new FabricWorkerError('INVALID_REQUEST', 'subjectId must be a positive integer');
  }
  if (value.instance !== undefined && value.instance !== null) text('instance', 1, 120);
  text('brief', 40, MAX_BRIEF_CHARS);
  if (value.model !== undefined && value.model !== null) text('model', 2, 80);
  if (value.harness !== undefined && value.harness !== null && !HARNESSES.has(value.harness)) {
    throw new FabricWorkerError('INVALID_REQUEST', `harness must be one of ${[...HARNESSES].join('|')}`);
  }
  if (value.deadlineMs !== undefined) {
    if (!Number.isSafeInteger(value.deadlineMs) || value.deadlineMs < 1000 || value.deadlineMs > 86400000) {
      throw new FabricWorkerError('INVALID_REQUEST', 'deadlineMs must be an integer in 1000..86400000');
    }
  }
  return value;
}

function validateWorkerReport(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('report must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!['schemaVersion', 'report', 'agentSessionId', 'numTurns'].includes(key)) {
      throw new Error(`unknown report key "${key}"`);
    }
  }
  if (value.schemaVersion !== REPORT_CONTRACT) throw new Error(`schemaVersion must be ${REPORT_CONTRACT}`);
  if (typeof value.report !== 'string' || value.report.length < 1 || value.report.length > MAX_REPORT_CHARS) {
    throw new Error(`report must be a string of 1..${MAX_REPORT_CHARS} chars`);
  }
  if (value.agentSessionId !== undefined && typeof value.agentSessionId !== 'string') {
    throw new Error('agentSessionId must be a string when present');
  }
  if (value.numTurns !== undefined && (!Number.isSafeInteger(value.numTurns) || value.numTurns < 0)) {
    throw new Error('numTurns must be a non-negative integer when present');
  }
  return value;
}

module.exports = Object.freeze({
  HARNESSES,
  DEFAULT_DEADLINE_MS,
  FabricWorkerError,
  MAX_BRIEF_CHARS,
  MAX_REPORT_CHARS,
  REPORT_CONTRACT,
  REQUEST_CONTRACT,
  validateWorkerReport,
  validateWorkerRequest
});
