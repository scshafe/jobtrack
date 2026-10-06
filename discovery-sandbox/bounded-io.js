'use strict';

const fs = require('node:fs');

class InputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}

async function readJsonInput({ file = null, stream = process.stdin, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer');
  let text;
  if (file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new InputError('INPUT_INVALID', 'Input path must be a non-symlink regular file');
    if (stat.size > maxBytes) throw new InputError('INPUT_TOO_LARGE', `Input exceeds ${maxBytes} bytes`);
    text = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new InputError('INPUT_TOO_LARGE', `Input exceeds ${maxBytes} bytes`);
  } else {
    text = await readStream(stream, maxBytes);
  }
  try { return JSON.parse(text); } catch { throw new InputError('INPUT_INVALID', 'Input must be exactly one valid JSON value'); }
}

function readStream(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (typeof stream.destroy === 'function') stream.destroy();
      reject(error);
    };
    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        fail(new InputError('INPUT_TOO_LARGE', `Input exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(buffer);
    });
    stream.on('error', (error) => fail(new InputError('INPUT_FAILED', safeMessage(error))));
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, bytes).toString('utf8'));
    });
  });
}

function safeMessage(error) {
  return String(error && error.message || 'input failed').replace(/[\r\n]+/g, ' ').slice(0, 300);
}

module.exports = { InputError, readJsonInput, readStream };
