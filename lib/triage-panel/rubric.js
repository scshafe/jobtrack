'use strict';

// The triage rubric.
//
// `opportunity_triage` has always had `score`, `score_coverage`,
// `dimensions_json`, and `hard_blockers_json`, but nothing in JobTrack ever
// computed them — they were caller-supplied opaque numbers with no definition
// anywhere in the repository. A panel cannot honestly populate that table
// without first saying what those numbers mean, so the meaning is defined here
// rather than implied by whatever the first caller happened to write.
//
// The rubric is versioned and digest-sealed. `rubric_version` on a triage row
// records which one produced it, so two scores are only ever compared when they
// were produced under the same definition.

const DIMENSIONS = Object.freeze([
  Object.freeze({
    key: 'role_fit',
    title: 'Role fit',
    weight: 3,
    asks: 'How closely does the work described match what Cole actually does?'
  }),
  Object.freeze({
    key: 'seniority_fit',
    title: 'Seniority fit',
    weight: 2,
    asks: 'Is the level appropriate — neither a step backwards nor a stretch that would be refused at screening?'
  }),
  Object.freeze({
    key: 'technical_alignment',
    title: 'Technical alignment',
    weight: 3,
    asks: 'Do the named technologies and problem domain overlap with demonstrable experience?'
  }),
  Object.freeze({
    key: 'company_signal',
    title: 'Company signal',
    weight: 2,
    asks: 'What does the posting reveal about stability, stage, and how the company treats engineers?'
  }),
  Object.freeze({
    key: 'logistics',
    title: 'Logistics',
    weight: 2,
    asks: 'Location, remote policy, and anything that would make this impractical.'
  }),
  Object.freeze({
    key: 'posting_quality',
    title: 'Posting quality',
    weight: 1,
    asks: 'Is the posting specific and internally consistent, or vague, recycled, or contradictory?'
  })
]);

const DIMENSION_KEYS = Object.freeze(DIMENSIONS.map((dimension) => dimension.key));

// A panellist may decline a dimension it cannot judge from the evidence. That
// abstention is the whole point of coverage: a confident score over two of six
// dimensions is not the same claim as the same score over all six, and the
// schema has always had a column to say so.
const ABSTAIN = 'abstain';

// Blockers are categorical, not scored. Any one panellist may raise one, and a
// raised blocker caps the decision regardless of how well everything else
// scored — a role Cole cannot legally take is not a 70.
const HARD_BLOCKERS = Object.freeze([
  'requires_clearance',
  'requires_relocation',
  'onsite_only_incompatible',
  'unpaid_or_equity_only',
  'seniority_mismatch_severe',
  'domain_excluded',
  'posting_expired'
]);

const DECISIONS = Object.freeze(['shortlist', 'watch', 'dismiss', 'revisit', 'note']);

// Score bands, applied only when coverage is sufficient. Below the coverage
// floor the panel does not get to call it — it says `revisit` and explains why,
// rather than converting thin evidence into a confident verdict.
const SHORTLIST_AT = 70;
const WATCH_AT = 45;
const MINIMUM_COVERAGE = 0.5;

const RUBRIC_VERSION = 'jobtrack.triage.v1';

/**
 * Coverage is the weighted fraction of the rubric the panel actually answered:
 * the summed weight of dimensions where at least one panellist scored, over the
 * total weight. It is an observation about the panel's reach, never an
 * invented confidence.
 */
function coverageOf(scoredKeys) {
  const total = DIMENSIONS.reduce((sum, dimension) => sum + dimension.weight, 0);
  const covered = DIMENSIONS
    .filter((dimension) => scoredKeys.includes(dimension.key))
    .reduce((sum, dimension) => sum + dimension.weight, 0);
  return total === 0 ? 0 : covered / total;
}

/**
 * The overall score is the weighted mean over answered dimensions only.
 * Unanswered dimensions are excluded rather than counted as zero — an
 * unanswered question is not a bad answer, and pretending otherwise would let
 * a thin panel manufacture a dismissal.
 */
function scoreOf(dimensionScores) {
  let weighted = 0;
  let weight = 0;
  for (const dimension of DIMENSIONS) {
    const value = dimensionScores[dimension.key];
    if (typeof value !== 'number') continue;
    weighted += value * dimension.weight;
    weight += dimension.weight;
  }
  return weight === 0 ? null : Math.round((weighted / weight) * 100) / 100;
}

/**
 * The decision. Blockers dominate; thin coverage forces a revisit; only a
 * well-covered, unblocked panel is allowed to shortlist or dismiss.
 */
function decisionOf({ score, coverage, hardBlockers }) {
  if (hardBlockers.length) return 'dismiss';
  if (score === null || coverage < MINIMUM_COVERAGE) return 'revisit';
  if (score >= SHORTLIST_AT) return 'shortlist';
  if (score >= WATCH_AT) return 'watch';
  return 'dismiss';
}

module.exports = Object.freeze({
  ABSTAIN,
  DECISIONS,
  DIMENSIONS,
  DIMENSION_KEYS,
  HARD_BLOCKERS,
  MINIMUM_COVERAGE,
  RUBRIC_VERSION,
  SHORTLIST_AT,
  WATCH_AT,
  coverageOf,
  decisionOf,
  scoreOf
});
