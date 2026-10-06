#!/usr/bin/env node
'use strict';

// Opt-in university/default-client route, not a replacement for system gog.
// This launcher does not confer permission to send or to bypass JobTrack edges.
const { spawnSync } = require('node:child_process');
const { resolvePinnedGog } = require('./lib/pinned-gog.cjs');
const { sanitizedGogEnvironment } = require('./lib/gog-environment.cjs');
const ACCOUNT = 'scshafe@umich.edu';
const SERVICES = new Set(['gmail', 'calendar', 'drive', 'contacts', 'sheets', 'docs', 'slides', 'tasks', 'people']);
function refused() { const e = new Error('GOG_SHARED_ROUTE_SCOPE_REFUSED'); e.code = e.message; throw e; }
function routeArgs(argv) {
  // Require a service first: deny auth/config/token export, global abbreviations,
  // response-file dispatch, and alternate account/client selection before spawn.
  if (!Array.isArray(argv) || !SERVICES.has(argv[0])) refused();
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string' || arg.includes('\0')) refused();
    if (arg === '--account' || arg === '-a' || arg === '--client') {
      const value = argv[++i];
      if (value !== (arg === '--client' ? 'default' : ACCOUNT)) refused();
      continue;
    }
    if (/^(?:--account=|-a=|--client=)/.test(arg)) {
      const [key, ...rest] = arg.split('=');
      if (rest.join('=') !== (key === '--client' ? 'default' : ACCOUNT)) refused();
      continue;
    }
    // Kong accepts joined short-option values; refuse every noncanonical -a.
    if (/^-a./.test(arg) || /^--(?:account|client)/.test(arg)) refused();
    if (/^--(?:home|access-token|acct|no-input|non-interactive|noninteractive|verbose|gmail-no-send)/.test(arg)
        || /^-[^-].+/.test(arg) || arg === '-v') refused();
    args.push(arg);
  }
  return ['--account', ACCOUNT, '--client=default', '--no-input', ...args];
}
function run(argv, deps = {}) {
  const args = routeArgs(argv);
  const binary = (deps.resolve || resolvePinnedGog)();
  const result = (deps.spawn || spawnSync)(binary, args, {
    env: sanitizedGogEnvironment(deps.env || process.env), stdio: 'inherit'
  });
  return result.status === 0 ? 0 : 2;
}
if (require.main === module) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) {
    const code = ['GOG_PINNED_BINARY_UNAVAILABLE','GOG_KEYCHAIN_ACCESS_PAUSED'].includes(error?.code)
      ? error.code : 'GOG_SHARED_ROUTE_SCOPE_REFUSED';
    process.stderr.write(`${code}\n`); process.exitCode = 2;
  }
}
module.exports = { routeArgs, run };
