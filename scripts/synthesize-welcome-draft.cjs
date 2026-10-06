'use strict';

// Retired unsafe fixture-based helper. Kept as a fail-closed entry point so an
// old daemon/brief cannot silently record synthetic provider evidence.
process.stderr.write('FIXTURE_DRAFT_RECIPE_RETIRED: use scripts/prepare-reply-draft.cjs with an explicit agent body; it creates and verifies a real native draft.\n');
process.exitCode = 2;
