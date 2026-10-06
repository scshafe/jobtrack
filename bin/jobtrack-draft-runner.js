#!/usr/bin/env node
'use strict';

// The standalone out-of-process JobTrack reply-draft runner.
//
// It reads one `jobtrack-email-reply-draft-request.v1` document on stdin and
// writes one `jobtrack-email-reply-draft-result.v1` document on stdout. It is
// a separate process by design and holds no authority of its own:
//
//   - no JobTrack store handle, no database driver, no JOBTRACK_HOME access;
//   - no network client, no credential, no mailbox, no provider adapter;
//   - no tool surface, no shell, no subprocess, no filesystem write;
//   - no send, no native draft, no approval.
//
// Its only output is data the JobTrack CLI re-validates from scratch before
// recording. A refusal exits non-zero with a typed reason and produces no
// proposal, so an unanswerable message can never become a silent draft.

const { DraftRefusal, DraftRunnerError, runDraftRequest } = require('../lib/draft-runner/pipeline');
const { VendorPinError } = require('../lib/draft-runner/vendor-pin');

const MAX_REQUEST_BYTES = 1_048_576;

function usage() {
  return [
    'Usage: jobtrack-draft-runner [--provenance <file>]',
    '',
    'Reads one jobtrack-email-reply-draft-request.v1 JSON document on stdin and',
    'writes one jobtrack-email-reply-draft-result.v1 JSON document on stdout.',
    '',
    'The runner performs no mailbox, network, credential, tool, draft, or send',
    'operation. Record its output with:',
    '',
    '  jobtrack email outgoing-draft-record --json <result-file>',
    '',
    'Options:',
    '  --provenance <file>  also write the run provenance and usage receipts',
    '  --help               show this message'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { provenance: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--provenance') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new DraftRunnerError('INVALID_ARGUMENT', '--provenance requires a file path');
      options.provenance = value;
      index += 1;
      continue;
    }
    throw new DraftRunnerError('INVALID_ARGUMENT', `Unknown argument: ${arg}`);
  }
  return options;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    process.stdin.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) {
        reject(new DraftRunnerError('REQUEST_TOO_LARGE', `The request exceeds ${MAX_REQUEST_BYTES} bytes`));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function failure(error) {
  const code = error && error.code ? String(error.code) : 'DRAFT_RUNNER_FAILED';
  const body = {
    schemaVersion: 'jobtrack-email-reply-draft-refusal.v1',
    code,
    message: error && error.message ? String(error.message) : 'The draft runner failed',
    ...(error && error.details ? { details: error.details } : {})
  };
  process.stderr.write(`${JSON.stringify(body, null, 2)}\n`);
  // 2 — the runner declined to compose a draft (policy, refusal, or invalid
  // request). 3 — the runner itself is not trustworthy (vendored engine pin).
  return error instanceof VendorPinError ? 3 : 2;
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { return failure(error); }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  let request;
  try {
    const text = await readStdin();
    if (!text.trim()) throw new DraftRunnerError('EMPTY_REQUEST', 'No request document was supplied on stdin');
    request = JSON.parse(text);
  } catch (error) {
    return failure(error instanceof SyntaxError
      ? new DraftRunnerError('INVALID_REQUEST_JSON', `The request is not valid JSON: ${error.message}`)
      : error);
  }

  let outcome;
  try { outcome = await runDraftRequest(request); }
  catch (error) { return failure(error); }

  if (options.provenance) {
    try {
      require('node:fs').writeFileSync(options.provenance, `${JSON.stringify(outcome.provenance, null, 2)}\n`);
    } catch (error) {
      return failure(new DraftRunnerError('PROVENANCE_WRITE_FAILED', `Could not write provenance: ${error.message}`));
    }
  }

  process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: 'jobtrack-email-reply-draft-refusal.v1',
      code: 'DRAFT_RUNNER_CRASHED',
      message: String((error && error.message) || error)
    }, null, 2)}\n`);
    process.exitCode = 2;
  }
);

module.exports = { DraftRefusal, parseArgs, usage };
