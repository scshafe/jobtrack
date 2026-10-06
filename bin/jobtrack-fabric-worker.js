#!/usr/bin/env node
'use strict';
// The standalone out-of-process FABRIC WORKER runner.
//
// Reads one `jobtrack-fabric-worker-request.v1` document on stdin, executes
// ONE agent turn through the byte-pinned Mission Pipeline engine, and writes
// one result document on stdout. Unlike the reply-draft runner, this process
// EXISTS to spawn an agent with tools: the turn it runs is a headless claude
// session that drives the drill store's CLI and the loopback site per its
// brief. What this process itself holds is only the harness:
//
//   - the engine's durable evidence (attempts, typed failures, usage
//     receipts) in <JOBTRACK_HOME>/pipeline-evidence.db — never the
//     canonical store;
//   - idempotent replay: a re-run of the same requestId answers from
//     committed evidence without spawning a second agent;
//   - the frozen agent-step taxonomy: failed is terminal, timed_out and
//     infra_error retry within the bounded attempt budget.
//
// Exit codes: 0 completed · 4 failed (terminal — the dispatcher decides
// whether to re-brief) · 5 timed_out · 6 infra_error · 2 bad request or
// runner error. The result document always carries the full story.
//
// Test seam: JOBTRACK_FABRIC_WORKER_EXECUTOR_MODULE names a CommonJS module
// exporting createExecutor(request) — tests substitute a deterministic
// executor; production leaves it unset and gets the claude turn.

const { runFabricWorkerRequest, FabricWorkerError } = require('../lib/fabric-worker-runner/pipeline');

const MAX_REQUEST_BYTES = 1_048_576;
const EXIT_BY_STATUS = { completed: 0, failed: 4, timed_out: 5, infra_error: 6 };

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new FabricWorkerError('REQUEST_TOO_LARGE', `request exceeds ${MAX_REQUEST_BYTES} bytes`));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

(async () => {
  let request;
  try {
    request = JSON.parse(await readStdin());
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 'jobtrack-fabric-worker-result.v1', status: 'invalid_request', error: String(error.message) })}\n`);
    process.exit(2);
  }
  const options = {};
  if (process.env.JOBTRACK_FABRIC_WORKER_EXECUTOR_MODULE) {
    // eslint-disable-next-line global-require
    options.executor = require(process.env.JOBTRACK_FABRIC_WORKER_EXECUTOR_MODULE).createExecutor(request);
  }
  try {
    const result = await runFabricWorkerRequest(request, options);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 'jobtrack-fabric-worker-result.v1', ...result })}\n`);
    process.exit(EXIT_BY_STATUS[result.status] ?? 2);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 'jobtrack-fabric-worker-result.v1',
      status: 'runner_error',
      error: { code: error.code ?? 'RUNNER_ERROR', message: String(error.message) }
    })}\n`);
    process.exit(2);
  }
})();
