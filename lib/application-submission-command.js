'use strict';

// CLI surface for the application-submission lane (lib/application-submission):
// propose -> approve -> claim -> settle, plus the per-application state view.
// The lane itself performs no network I/O — these commands decide whether a
// submission MAY happen and record what DID happen; driving the wire is the
// caller's job (today: the applysim drill player; someday: a real apply flow).
//
// Two ways to propose an intent:
//   --answers-file + --documents-file   the caller digests the exact wire
//                                       answer set and document hashes itself;
//   --package-id + --expected-readiness-sha256
//                                       the intent is derived from a prepared
//                                       package's bound facts, so the signed
//                                       approval covers precisely the bytes
//                                       verify-uploads and record-submission
//                                       will later check.

const fs = require('node:fs');

const {
  SubmissionError,
  approveSubmission,
  claimSubmissionAttempt,
  proposeSubmission,
  readSubmissionState,
  settleSubmissionAttempt
} = require('./application-submission');
const { readPackageSubmissionFacts } = require('./application-materials');

const APPLICATION_SUBMISSION_FLAG_SCHEMAS = Object.freeze({
  propose: [
    'applicationId', 'id', 'surfaceId', 'intentId', 'answersFile', 'documentsFile',
    'packageId', 'expectedReadinessSha256'
  ],
  approve: ['intentId', 'expectedIntentDigest', 'approverKind', 'approverId', 'approvalId'],
  claim: ['approvalId', 'attemptId'],
  settle: ['attemptId', 'outcome', 'externalReference', 'evidenceFile'],
  state: ['applicationId', 'id']
});

function assertApplicationSubmissionCommandFlags(action, flags) {
  const schema = APPLICATION_SUBMISSION_FLAG_SCHEMAS[action];
  if (!schema) {
    throw new SubmissionError(
      'UNKNOWN_COMMAND',
      `Unknown application-submission action: ${action || '(missing)'} (use propose, approve, claim, settle, or state)`
    );
  }
  const allowed = new Set(schema);
  const unknown = Object.keys(flags).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new SubmissionError(
      'INVALID_ARGUMENT',
      `Unknown flag(s) for application-submission ${action}: ${unknown.sort().map(toFlag).join(', ')}`
    );
  }
}

function runApplicationSubmissionCommand(db, args, flags = {}, services = {}) {
  const action = args[0] || 'state';
  if (args.length > 2) {
    throw new SubmissionError('INVALID_ARGUMENT', 'Use one action and at most one positional application id');
  }
  assertApplicationSubmissionCommandFlags(action, flags);
  const home = services.home;

  if (action === 'propose') {
    const applicationId = requiredApplicationId(flags, args);
    const packageMode = flags.packageId !== undefined;
    const fileMode = flags.answersFile !== undefined || flags.documentsFile !== undefined;
    if (packageMode && fileMode) {
      throw new SubmissionError(
        'INVALID_ARGUMENT',
        'Propose from ONE source: either --package-id (derived from the bound package) or --answers-file with --documents-file'
      );
    }
    let answers;
    let documents;
    let source;
    if (packageMode) {
      if (flags.expectedReadinessSha256 === undefined) {
        throw new SubmissionError(
          'INVALID_ARGUMENT',
          '--expected-readiness-sha256 is required with --package-id: pin the readiness you reviewed, not whatever is current'
        );
      }
      const facts = readPackageSubmissionFacts(db, {
        applicationId,
        packageId: flags.packageId,
        expectedReadinessSha256: flags.expectedReadinessSha256
      });
      if (facts.packageStatus !== 'ready') {
        throw new SubmissionError(
          'PACKAGE_NOT_READY',
          `Package ${facts.packageId} is ${facts.packageStatus}, not ready; propose covers a package that is still awaiting the wire`
        );
      }
      ({ answers, documents } = facts);
      source = {
        mode: 'package',
        packageId: facts.packageId,
        readinessSha256: facts.readinessSha256,
        documents,
        answers
      };
    } else {
      if (flags.answersFile === undefined || flags.documentsFile === undefined) {
        throw new SubmissionError(
          'INVALID_ARGUMENT',
          'Propose needs both --answers-file and --documents-file (or --package-id with --expected-readiness-sha256)'
        );
      }
      answers = readJsonFile(flags.answersFile, '--answers-file');
      documents = readJsonFile(flags.documentsFile, '--documents-file');
      source = { mode: 'files' };
    }
    const result = proposeSubmission(db, {
      intentId: flags.intentId,
      applicationId,
      surfaceId: flags.surfaceId,
      answers,
      documents
    });
    return { ...result, source };
  }

  if (action === 'approve') {
    return approveSubmission(db, {
      intentId: flags.intentId,
      expectedIntentDigest: flags.expectedIntentDigest,
      approver: { kind: flags.approverKind, id: flags.approverId },
      approvalId: flags.approvalId,
      home
    });
  }

  if (action === 'claim') {
    return claimSubmissionAttempt(db, {
      approvalId: flags.approvalId,
      attemptId: flags.attemptId,
      home
    });
  }

  if (action === 'settle') {
    return settleSubmissionAttempt(db, {
      attemptId: flags.attemptId,
      outcome: flags.outcome,
      externalReference: flags.externalReference,
      ...(flags.evidenceFile !== undefined
        ? { evidence: readJsonFile(flags.evidenceFile, '--evidence-file') }
        : {})
    });
  }

  // state
  return readSubmissionState(db, requiredApplicationId(flags, args));
}

function requiredApplicationId(flags, args) {
  const raw = flags.applicationId ?? flags.id ?? args[1];
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new SubmissionError('INVALID_ARGUMENT', 'Pass --application-id (or one positional application id)');
  }
  return parsed;
}

function readJsonFile(filePath, label) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new SubmissionError('INVALID_ARGUMENT', `${label} must be a path to a JSON file`);
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new SubmissionError('INVALID_ARGUMENT', `${label} unreadable at ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new SubmissionError('INVALID_ARGUMENT', `${label} is not valid JSON (${filePath}): ${error.message}`);
  }
}

function toFlag(key) {
  return `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

module.exports = {
  APPLICATION_SUBMISSION_FLAG_SCHEMAS,
  assertApplicationSubmissionCommandFlags,
  runApplicationSubmissionCommand
};
