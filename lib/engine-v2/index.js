'use strict';

// lib/engine-v2 — JobTrack's host seam for the Mission Pipeline v2 node-graph
// engine (vendored byte-pinned as vendor/mission-pipeline, loaded through
// lib/draft-runner/vendor-pin.js). Three runners sit on it: the fabric worker
// (one agent node per dispatch), the reply-draft runner and the opportunity
// triage panel (state-accumulating code/model chains). docs/V2-ENGINE-PORT.md.

const { SqliteUnitStore, ALL_SCOPE } = require('./sqlite-unit-store');
const { OK, REFUSED, defineLinearGraph } = require('./linear-graph');
const { createCodePort, createModelPort, unavailableReceipt } = require('./ports');
const { refusalOf, runUnitToCompletion } = require('./run-unit');

module.exports = Object.freeze({
  ALL_SCOPE,
  OK,
  REFUSED,
  SqliteUnitStore,
  createCodePort,
  createModelPort,
  defineLinearGraph,
  refusalOf,
  runUnitToCompletion,
  unavailableReceipt
});
