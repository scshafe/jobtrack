#!/usr/bin/env node
'use strict';

// Main's general Google entry point requires an explicit approved account.
// University calls retain the existing route's pin, pause, and scope checks.
// Personal accounts are intentionally unavailable until separately approved.
const { routeArgs: universityRouteArgs, run: runUniversity } = require('./gog-umich.cjs');
const UNIVERSITY_ACCOUNT = 'scshafe@umich.edu';
const SCOPE_REFUSED = 'GOG_SHARED_ROUTE_SCOPE_REFUSED';
function refused(code = SCOPE_REFUSED) { const error = new Error(code); error.code = code; throw error; }

function routeArgs(argv) {
  if (!Array.isArray(argv)) refused();
  let account;
  let selected = false;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string' || arg.includes('\0') || arg === '--') refused();
    if (arg === '--account' || arg === '-a') {
      if (selected) refused();
      selected = true;
      account = argv[++i];
      if (typeof account !== 'string' || !account || account.includes('\0') || account.startsWith('-')) refused();
      continue;
    }
    if (arg.startsWith('--account=')) {
      if (selected) refused();
      selected = true;
      account = arg.slice('--account='.length);
      if (!account) refused();
      continue;
    }
    // No abbreviated/aliased account selection or joined short options.
    if (/^(?:--account|--acct|-a.)/.test(arg)) refused();
    args.push(arg);
  }
  if (!selected) refused('GOG_MAIN_EXPLICIT_ACCOUNT_REQUIRED');
  if (account !== UNIVERSITY_ACCOUNT) refused('GOG_MAIN_ACCOUNT_NOT_APPROVED');
  // Validate before delegation, without resolving an executable or credentials.
  // This preserves service-first dispatch and all university-route denials.
  universityRouteArgs(args);
  return args;
}

function run(argv, deps = {}) {
  const args = routeArgs(argv);
  return (deps.delegate || runUniversity)(args, deps);
}

if (require.main === module) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) {
    const code = [SCOPE_REFUSED, 'GOG_MAIN_EXPLICIT_ACCOUNT_REQUIRED', 'GOG_MAIN_ACCOUNT_NOT_APPROVED',
      'GOG_PINNED_BINARY_UNAVAILABLE', 'GOG_KEYCHAIN_ACCESS_PAUSED'].includes(error?.code)
      ? error.code : SCOPE_REFUSED;
    process.stderr.write(`${code}\n`); process.exitCode = 2;
  }
}
module.exports = { routeArgs, run };
