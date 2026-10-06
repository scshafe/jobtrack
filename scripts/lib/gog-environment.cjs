'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Native mail operations name one approved account on the host credential
// store. Ambient direct tokens, ADC, client/root overrides or output-shaping
// flags must not change that authority. Keep keyring access and no-send fences.
function sanitizedGogEnvironment(environment = process.env) {
  const allowedGog = new Set(['GOG_KEYRING_PASSWORD', 'GOG_GMAIL_NO_SEND']);
  const blocked = new Set(['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_QUOTA_PROJECT',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']);
  const clean = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    (!key.startsWith('GOG_') || allowedGog.has(key)) && !blocked.has(key)));
  // Fail closed to the existing, deliberately shared macOS credential store.
  clean.GOG_KEYRING_BACKEND = 'keychain';
  clean.GOG_KEYRING_SERVICE_NAME = 'gogcli';
  return clean;
}

function gogWorkerEnvironment(environment = process.env) {
  const clean = sanitizedGogEnvironment(environment);
  const route = path.resolve(__dirname, '../../tools/gog/umich-bin');
  // A missing shim must stop worker launch, not expose the Homebrew PATH entry.
  for (const file of [route, path.join(route, 'gog')]) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || fs.realpathSync(file) !== file || (stat.mode & 0o022)
          || stat.uid !== process.getuid() || !(stat.mode & 0o100)
          || (file === route ? !stat.isDirectory() : !stat.isFile())) throw new Error();
    } catch {
      const error = new Error('GOG_SHARED_ROUTE_UNAVAILABLE'); error.code = error.message; throw error;
    }
  }
  clean.PATH = [route, ...(clean.PATH || '').split(path.delimiter).filter(p => p && p !== route)].join(path.delimiter);
  return clean;
}
module.exports = { sanitizedGogEnvironment, gogWorkerEnvironment };
