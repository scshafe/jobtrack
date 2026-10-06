'use strict';

// Historical template recipes are deliberately fail-closed. Native adapter,
// separate sealing, and exact replay tests live in email-prepare-reply.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
for (const kind of ['interview_invite', 'agent']) {
  test(`retired synthesis recipe refuses ${kind} before opening a store or mailbox`, () => {
    assert.throws(() => execFileSync(process.execPath,
      [path.resolve(__dirname, '../scripts/synthesize-welcome-draft.cjs'), '--kind', kind],
      // Keep the nonexistent target: refusal must precede any store setup.
      { env: { JOBTRACK_HOME: '/nonexistent/never-created-jobtrack-test-store',
        JOBTRACK_DB: '/nonexistent/never-created-jobtrack-test-store/jobtrack.db' }, stdio: 'pipe' }),
    (error) => error.status === 2 && /FIXTURE_DRAFT_RECIPE_RETIRED/.test(String(error.stderr)));
  });
}
