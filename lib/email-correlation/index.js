'use strict';

const crypto = require('node:crypto');
const { CandidateSet, enrichInterviewCandidates, orderCandidates } = require('./candidates');
const { identifySender, publicIdentity } = require('./identity');
const { runBases } = require('./bases/index');
const { resolve } = require('./resolve');
const { extractSignals, prioritizeRoleTitleMatchEvidence } = require('./signals');

function correlate(facts, store, policy) {
  if (!facts || !store || !policy) throw new TypeError('correlate(facts, store, policy) requires all three inputs');
  const signals = extractSignals(facts);
  const identity = identifySender(signals, store);
  const candidates = new CandidateSet(store);
  const evidence = [];
  const ctx = Object.freeze({
    facts,
    signals,
    identity,
    store,
    policy,
    candidates,
    evidence,
    addCandidate: candidates.add.bind(candidates)
  });
  runBases(ctx);
  enrichInterviewCandidates(ctx);
  const ordered = orderCandidates(candidates.values(), policy);
  const outcome = resolve(ordered, { ...identity, messageClarifiable: signals.clarifiable }, policy);
  const source = {
    provider: facts.source.provider,
    accountId: facts.source.accountId,
    messageId: facts.source.messageId,
    threadId: facts.source.threadId
  };
  const base = {
    schemaVersion: facts.schemaVersion === 'job-application-email-facts.v2'
      ? 'jobtrack-correlation-result.v3'
      : 'jobtrack-correlation-result.v1',
    source,
    factsDigest: digest(facts),
    ...(facts.schemaVersion === 'job-application-email-facts.v2'
      ? { policyRevisionId: policy.revisionId, identity: publicIdentity(identity) }
      : {}),
    resolution: outcome.resolution,
    ...(outcome.resolved ? { resolved: outcome.resolved } : {}),
    ...(outcome.preferredCandidateId ? { preferredCandidateId: outcome.preferredCandidateId } : {}),
    candidates: outcome.resolution === 'unmatched' ? [] : ordered,
    // Causal title bindings must survive the public contract's evidence cap;
    // otherwise a confirmed candidate could silently lose the only durable
    // proof authorizing its title-alias learning.
    evidence: prioritizeRoleTitleMatchEvidence(evidence, outcome.resolved?.applicationId).slice(0, 30),
    automaticEligible: outcome.automaticEligible,
    ...(facts.schemaVersion === 'job-application-email-facts.v2' ? { clarifiable: outcome.clarifiable } : {})
  };
  return base;
}

function digest(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

module.exports = { correlate };
