'use strict';

// JobTrack web: the bootstrap.
//
// Everything this process actually does lives under lib/web/ — the route table
// (routes.js), the read models (read-model/), the renderers (render/), the
// filter layer (filters.js + toolbar.js), and the read-only store snapshot
// (store.js). What is left here is the part that only makes sense as a
// PROCESS: which address to bind, and how to give the snapshot back when the
// process ends.
//
// The binding check runs before anything is served AND before anything is
// allocated: requiring lib/web/store.js opens no database and creates no
// temporary directory (the read cache is built on first read), so a refused
// binding leaves nothing behind to clean up. test/server-security.test.js
// pins exactly that.

const { DB_PATH, cleanupReadCache } = require('./lib/web/store');
const { app } = require('./lib/web/routes');
const { listApplications } = require('./lib/web/read-model/applications');
const { listProfileEntries } = require('./lib/web/read-model/profile');
const { sortApplications } = require('./lib/web/read-model/rows');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
if (!LOOPBACK_HOSTS.has(HOST) && process.env.JOBTRACK_ALLOW_NON_LOOPBACK !== '1') {
  throw new Error('Refusing non-loopback JobTrack web binding; use a local reverse proxy or set JOBTRACK_ALLOW_NON_LOOPBACK=1 deliberately');
}

let server;
let closing = false;

if (require.main === module) {
  server = app.listen(PORT, HOST, () => {
    console.log(`JobTrack web listening on http://${HOST}:${PORT}`);
    console.log(`Reading ${DB_PATH}`);
  });
}

process.on('SIGTERM', closeGracefully);
process.on('SIGINT', closeGracefully);
process.once('exit', cleanupReadCache);

function closeGracefully() {
  if (closing) return;
  closing = true;
  if (server) {
    server.close(cleanupReadCache);
    return;
  }
  cleanupReadCache();
}

module.exports = { app, listApplications, listProfileEntries, sortApplications };
