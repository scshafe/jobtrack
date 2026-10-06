'use strict';

const REGISTER_POLICY_VERSION = 'register-adaptation.v1';
const OBSERVATION_POLICY_VERSION = 'register-observation.v1';
const MAX_STYLE_OBSERVATIONS = 8;
const STYLE_PROFILE_FRESHNESS_HORIZON_DAYS = 180;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const DIMENSION_VALUES = Object.freeze({
  formality: Object.freeze(['casual', 'neutral', 'formal']),
  warmth: Object.freeze(['reserved', 'neutral', 'warm']),
  energy: Object.freeze(['restrained', 'neutral', 'upbeat']),
  directness: Object.freeze(['contextual', 'balanced', 'direct']),
  verbosity: Object.freeze(['terse', 'concise', 'moderate'])
});

const DIMENSION_FALLBACKS = Object.freeze({
  formality: 'neutral',
  warmth: 'neutral',
  energy: 'neutral',
  directness: 'balanced',
  verbosity: 'concise'
});

const PROFILE_SAFEGUARDS = Object.freeze({
  registerAdaptationOnly: true,
  sensitiveTraitInference: false,
  personalityInference: false,
  distinctivePhraseReuse: false
});

const TONE_POLICY = Object.freeze({
  version: REGISTER_POLICY_VERSION,
  fallback: 'neutral_professional',
  maxBandShift: 1,
  registerAdaptationOnly: true,
  sensitiveTraitInference: false,
  personalityInference: false,
  distinctivePhraseReuse: false
});

const STYLE_PROFILE_FRESHNESS_POLICY = Object.freeze({
  horizonDays: STYLE_PROFILE_FRESHNESS_HORIZON_DAYS,
  basis: 'sample.lastObservedAt'
});

function evaluateStyleProfileFreshness(profile, evaluatedAt = new Date()) {
  const lastObservedAt = parseTimestamp(profile?.sample?.lastObservedAt, 'profile sample lastObservedAt');
  const evaluationTime = parseTimestamp(evaluatedAt, 'profile freshness evaluation time');
  const expiresAtMilliseconds = lastObservedAt.getTime()
    + STYLE_PROFILE_FRESHNESS_HORIZON_DAYS * MILLISECONDS_PER_DAY;
  const expiresAt = new Date(expiresAtMilliseconds).toISOString();
  const isStale = evaluationTime.getTime() >= expiresAtMilliseconds;
  return {
    ...STYLE_PROFILE_FRESHNESS_POLICY,
    lastObservedAt: lastObservedAt.toISOString(),
    expiresAt,
    isStale,
    staleReason: isStale ? 'time_horizon_elapsed' : null
  };
}

function aggregateStyleObservations(observations) {
  if (!Array.isArray(observations) || observations.length < 1 || observations.length > MAX_STYLE_OBSERVATIONS) {
    throw new TypeError(`Style aggregation requires 1 to ${MAX_STYLE_OBSERVATIONS} observations`);
  }
  const distinctMessages = new Set(observations.map((observation) => sourceMessageKey(observation.source)));
  if (distinctMessages.size !== observations.length) {
    throw new TypeError('Style aggregation permits at most one observation per source message');
  }
  const dimensions = {};
  const agreements = [];
  for (const [dimension, allowed] of Object.entries(DIMENSION_VALUES)) {
    const votes = observations
      .map((observation) => observation.dimensions?.[dimension])
      .filter((value) => allowed.includes(value));
    const selected = deterministicMode(votes, DIMENSION_FALLBACKS[dimension]);
    dimensions[dimension] = selected;
    agreements.push(votes.length ? votes.filter((value) => value === selected).length / votes.length : 0);
  }
  const eligibleMessageCount = observations.length;
  const distinctThreadCount = new Set(observations.map((observation) => sourceThreadKey(observation.source))).size;
  const received = observations.map((observation) => observation.receivedAt).sort();
  const averageAgreement = agreements.reduce((total, value) => total + value, 0) / agreements.length;
  const confidence = eligibleMessageCount >= 5 && averageAgreement >= 0.75
    ? 'high'
    : eligibleMessageCount >= 3 && averageAgreement >= 0.6
      ? 'medium'
      : 'low';
  return {
    dimensions,
    delivery: aggregateDelivery(observations, dimensions),
    confidence,
    sample: {
      eligibleMessageCount,
      distinctThreadCount,
      firstObservedAt: received[0],
      lastObservedAt: received.at(-1)
    },
    safeguards: { ...PROFILE_SAFEGUARDS }
  };
}

function aggregateDelivery(observations, dimensions) {
  const greetings = observations.map((entry) => entry.surfaceSignals?.greeting).filter(Boolean);
  const closings = observations.map((entry) => entry.surfaceSignals?.closing).filter(Boolean);
  const greeting = mapGreeting(deterministicMode(greetings.filter((value) => value !== 'unknown'), 'hello'));
  const closing = mapClosing(deterministicMode(closings.filter((value) => value !== 'unknown'), 'best'));
  const exclamationObserved = observations.some((entry) => ['one', 'multiple'].includes(entry.surfaceSignals?.exclamation));
  const emojiObserved = observations.some((entry) => entry.surfaceSignals?.emoji === 'present');
  const contractionsObserved = observations.filter((entry) => entry.surfaceSignals?.contractions === 'present').length > observations.length / 2;
  return {
    greeting,
    closing,
    exclamationPolicy: exclamationObserved && (dimensions.warmth === 'warm' || dimensions.energy === 'upbeat')
      ? 'at_most_one'
      : 'none',
    emojiPolicy: emojiObserved ? 'reciprocal_only' : 'none',
    contractions: contractionsObserved ? 'allow' : 'avoid'
  };
}

function resolveRegisterAdaptation({ voice, recipientProfile = null, purpose, conservative = false }) {
  const maximumShift = Math.min(1, voice.delivery.maxBandShift);
  const profileConfident = !conservative && recipientProfile && recipientProfile.confidence !== 'low';
  const dimensions = {};
  for (const [dimension, allowed] of Object.entries(DIMENSION_VALUES)) {
    const baseline = voice.dimensions[dimension];
    const requested = purposeTarget(dimension, purpose)
      || (profileConfident ? recipientProfile.dimensions?.[dimension] : undefined);
    dimensions[dimension] = clampBand(baseline, requested, allowed, maximumShift);
  }
  const profileDelivery = profileConfident ? recipientProfile.delivery : null;
  const exclamationPermittedByRegister = !profileDelivery
    || profileDelivery.exclamationPolicy === 'at_most_one';
  return {
    dimensions,
    delivery: {
      greeting: profileDelivery?.greeting || voice.delivery.greeting,
      closing: profileDelivery?.closing || voice.delivery.closing,
      exclamationPolicy: !conservative && voice.delivery.exclamationPolicy === 'at_most_one'
        && exclamationPermittedByRegister
        && (dimensions.warmth === 'warm' || dimensions.energy === 'upbeat')
        ? 'at_most_one'
        : 'none',
      // Recipient behavior never authorizes emoji or identity-signaling mimicry.
      emojiPolicy: 'none',
      contractions: conservative
        ? 'avoid'
        : voice.delivery.contractions === 'allow' && profileDelivery?.contractions === 'allow'
        ? 'allow'
        : voice.delivery.contractions
    }
  };
}

function purposeTarget(dimension, purpose) {
  if (purpose === 'scheduling' && dimension === 'directness') return 'direct';
  if (['scheduling', 'follow_up', 'acknowledgement'].includes(purpose) && dimension === 'verbosity') return 'concise';
  if (purpose === 'information_response' && dimension === 'directness') return 'balanced';
  return null;
}

function clampBand(baseline, requested, allowed, maximumShift) {
  const baselineIndex = allowed.indexOf(baseline);
  if (baselineIndex < 0) throw new TypeError(`Invalid voice baseline ${baseline}`);
  const requestedIndex = allowed.indexOf(requested);
  if (requestedIndex < 0 || maximumShift === 0) return baseline;
  const difference = Math.max(-maximumShift, Math.min(maximumShift, requestedIndex - baselineIndex));
  return allowed[baselineIndex + difference];
}

function deterministicMode(values, fallback) {
  if (!values.length) return fallback;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const maximum = Math.max(...counts.values());
  const winners = [...counts.entries()].filter(([, count]) => count === maximum).map(([value]) => value);
  return winners.length === 1 ? winners[0] : winners.includes(fallback) ? fallback : fallback;
}

function mapGreeting(value) {
  if (value === 'none') return 'omit';
  if (['name', 'hi', 'hello', 'dear'].includes(value)) return value;
  return 'hello';
}

function mapClosing(value) {
  if (value === 'none') return 'none';
  if (['thanks', 'best', 'regards'].includes(value)) return value;
  return 'best';
}

function sourceThreadKey(source) {
  return `${source.provider}\u0000${source.accountId}\u0000${source.threadId}`;
}

function sourceMessageKey(source) {
  return `${source.provider}\u0000${source.accountId}\u0000${source.messageId}`;
}

function parseTimestamp(value, label) {
  const timestamp = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError(`Invalid ${label}`);
  return timestamp;
}

module.exports = {
  DIMENSION_FALLBACKS,
  DIMENSION_VALUES,
  MAX_STYLE_OBSERVATIONS,
  OBSERVATION_POLICY_VERSION,
  PROFILE_SAFEGUARDS,
  REGISTER_POLICY_VERSION,
  STYLE_PROFILE_FRESHNESS_HORIZON_DAYS,
  STYLE_PROFILE_FRESHNESS_POLICY,
  TONE_POLICY,
  aggregateStyleObservations,
  evaluateStyleProfileFreshness,
  resolveRegisterAdaptation,
  sourceMessageKey,
  sourceThreadKey
};
