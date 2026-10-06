'use strict';
// A loopback port the OS reports free right now: bind 127.0.0.1:0, read the
// port, release it. Web tests used fixed or pid-derived ranges that overlapped
// between files (and with other services on the host), so a file running next
// to another could find its port taken and the server "exited early".
const net = require('node:net');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

module.exports = { freePort };
