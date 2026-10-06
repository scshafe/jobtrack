'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_IMPORT_BYTES,
  DiscoveryImportError,
  acceptDiscoveryProposal,
  getDiscoveryProposal,
  importProposalBundle,
  listDiscoveryProposals,
  rejectDiscoveryProposal
} = require('./discovery-importer');

const COMMAND_FLAGS = Object.freeze({
  import: ['input', 'importedBy'],
  list: ['status', 'limit'],
  show: ['proposalId'],
  accept: ['proposalId', 'decidedBy', 'rationale', 'idempotencyKey'],
  reject: ['proposalId', 'decidedBy', 'rationale', 'idempotencyKey']
});

function assertDiscoveryProposalCommandFlags(action, flags) {
  const schema = COMMAND_FLAGS[action];
  if (!schema) throw new DiscoveryImportError('UNKNOWN_COMMAND', `Unknown discovery proposal command: ${action || '(missing)'}`);
  const allowed = new Set(schema);
  const unknown = Object.keys(flags).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new DiscoveryImportError('INVALID_ARGUMENT', `Unknown flag(s) for discovery proposal ${action}: ${unknown.sort().map(toFlag).join(', ')}`);
  }
}

function runDiscoveryProposalCommand(db, args, flags) {
  const action = args[0];
  if (args.length !== 1) {
    throw new DiscoveryImportError('INVALID_ARGUMENT', 'Use exactly one discovery proposal action');
  }
  assertDiscoveryProposalCommandFlags(action, flags);
  switch (action) {
    case 'import':
      return importProposalBundle(db, readBoundedFile(required(flags.input, '--input')), {
        importedBy: required(flags.importedBy, '--imported-by')
      });
    case 'list':
      return {
        proposals: listDiscoveryProposals(db, {
          status: flags.status,
          limit: flags.limit === undefined ? undefined : positiveInteger(flags.limit, '--limit', 500)
        })
      };
    case 'show':
      return { proposal: getDiscoveryProposal(db, required(flags.proposalId, '--proposal-id')) };
    case 'accept':
      return acceptDiscoveryProposal(db, reviewInput(flags));
    case 'reject':
      return rejectDiscoveryProposal(db, reviewInput(flags));
    default:
      throw new DiscoveryImportError('UNKNOWN_COMMAND', `Unknown discovery proposal command: ${action || '(missing)'}`);
  }
}

function reviewInput(flags) {
  return {
    proposalId: required(flags.proposalId, '--proposal-id'),
    decidedBy: required(flags.decidedBy, '--decided-by'),
    rationale: required(flags.rationale, '--rationale'),
    idempotencyKey: required(flags.idempotencyKey, '--idempotency-key')
  };
}

function readBoundedFile(value) {
  const filename = path.resolve(required(value, '--input'));
  const stat = fs.statSync(filename);
  if (!stat.isFile()) throw new DiscoveryImportError('INVALID_INPUT', '--input must identify a regular file');
  if (stat.size > MAX_IMPORT_BYTES) {
    throw new DiscoveryImportError('IMPORT_LIMIT_EXCEEDED', `Input is ${stat.size} bytes; limit is ${MAX_IMPORT_BYTES}`);
  }
  return fs.readFileSync(filename);
}

function required(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new DiscoveryImportError('VALIDATION_ERROR', `${label} is required`);
  }
  return String(value).trim();
}

function positiveInteger(value, label, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new DiscoveryImportError('VALIDATION_ERROR', `${label} must be an integer from 1 to ${max}`);
  }
  return number;
}

function toFlag(value) {
  return `--${value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`;
}

module.exports = {
  assertDiscoveryProposalCommandFlags,
  runDiscoveryProposalCommand
};
