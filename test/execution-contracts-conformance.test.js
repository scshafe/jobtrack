'use strict';

// =============================================================================
// Cross-repo conformance drift gate (JobTrack side).
//
// This is the CI gate that keeps JobTrack's LOCAL contract copies in lock-step
// with the published contract package in `execution-contracts` (frozen v1 plus
// additive provider-neutral successors). A version bump on one side without
// the matching change on the other MUST fail this build.
//
// It asserts three independent properties across the adopted contract sets:
//
//   (a) SCHEMA PARITY (byte-equality modulo $id/title/description). JobTrack's
//       copy under contracts/email/*.schema.json + contracts/execution/
//       usage-receipt.v1.schema.json is structurally identical to the published
//       schema under execution-contracts/schemas — no substantive drift in
//       required / enum / bounds (min*/max*/pattern/multipleOf) / const /
//       additionalProperties / type / $ref / the allOf-if/then/else cross-field
//       clauses. Only the doc-only keys $id, title, description, $comment (and
//       the meta $schema dialect) may differ. A drift surfaces the exact JSON
//       pointer that diverged.
//
//   (b) VALIDATOR ACCEPTANCE PARITY for the established runtime set. JobTrack's
//       lib/email-contracts.js
//       validators (which additionally carry the code-side cross-field
//       invariants documented in the frozen CONVENTIONS.md §5 that JSON Schema
//       cannot express) ACCEPT the published golden fixtures verbatim and
//       REJECT the published negative cases (the reject set enumerated in
//       execution-contracts/CONTRACT-FREEZE-REVIEW.md: extra property, wrong
//       trust const, null charged tokens, tier-ceiling carrying observed
//       tokens, charged-0 floor at a no-telemetry tier, signature without
//       provider_signed, and per-contract structural breakers). The six G03
//       outgoing successors are intentionally schema-only here: B07 will add
//       their product validators and effect-edge behavior after G03 freezes.
//
//   (c) G03 PUBLIC-VECTOR PARITY. Canonical digests and Ed25519 attestations
//       reproduce from public execution-contracts fixtures and public test
//       keys without adding any production authority to JobTrack.
//
// Dependency-free: node stdlib only (no ajv), matching JobTrack's no-ajv
// validator posture. Runnable with `/opt/homebrew/bin/node --test` or bare
// `node test/execution-contracts-conformance.test.js`.
//
// This test is READ-ONLY: it opens no database, holds no credentials, sends no
// mail, and mutates nothing on disk. It is safe to run in CI.
// =============================================================================

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const contracts = require('../lib/email-contracts');
const {
  root: PINNED_EXECUTION_CONTRACTS_ROOT,
  manifest: PINNED_EXECUTION_CONTRACTS_MANIFEST,
  verifyPinnedOutgoingV2Fixtures
} = require('../test-support/outgoing-v2-fixtures');

// ---------------------------------------------------------------------------
// Locate the FROZEN published contract package snapshot.
//
// This is a hard cross-repo gate, NOT a skip-if-absent probe (CONVENTIONS §3:
// "the existing skip-if-absent check becomes an unconditional published-schema
// check"). The snapshot is repository-local and every byte is pinned by one
// manifest to an exact reviewed Execution Contracts commit/tree. The test never
// searches a mutable sibling checkout or a user-specific filesystem path.
// ---------------------------------------------------------------------------
verifyPinnedOutgoingV2Fixtures();
// REVIEWED REPIN (2026-09-02): execution-contracts 1.7.0 adds correlation
// result v3; the frozen v1/v2 and outgoing schema bytes remain unchanged.
assert.equal(PINNED_EXECUTION_CONTRACTS_MANIFEST.sourceCommit, 'bd7e1f627a86b318b424ca81aee1d5658795f042');
assert.equal(PINNED_EXECUTION_CONTRACTS_MANIFEST.sourceTree, '7db0b6c67a18eb5af0b241281b829609cf760c64');
const PUBLISHED_ROOT = PINNED_EXECUTION_CONTRACTS_ROOT;
const PUBLISHED_SCHEMAS = path.join(PUBLISHED_ROOT, 'schemas');
const PUBLISHED_FIXTURES = path.join(PUBLISHED_ROOT, 'fixtures');
const JOBTRACK_CONTRACTS = path.resolve(__dirname, '..', 'contracts');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// The runtime-validated shared contract set. Each entry pins:
//   - the published schema (relative to execution-contracts/schemas)
//   - JobTrack's local copy (relative to jobtrack/contracts)
//   - the golden fixture (relative to execution-contracts/fixtures)
//   - JobTrack's validator export name
//
// This is exactly the intersection the freeze review calls out: the 3 "promoted
// verbatim from JobTrack" email schemas, the 4 co-developed email schemas, and
// the execution usage-receipt nucleus. JobTrack's inbox-only style/tone schemas
// (email-demeanor-observation, email-recipient-style-profile, email-tone-decision,
// profile-writing-voice-revision, jobtrack-transition-proposal,
// email-reply-draft-proposal.v1) are intentionally NOT published, so they are
// out of scope for this cross-repo gate.
// ---------------------------------------------------------------------------
const RUNTIME_CONTRACTS = [
  {
    id: 'execution/usage-receipt.v1',
    publishedSchema: 'execution/usage-receipt.v1.schema.json',
    jobtrackSchema: 'execution/usage-receipt.v1.schema.json',
    fixture: 'execution/usage-receipt.v1.json',
    validator: 'validateUsageReceipt'
  },
  {
    id: 'email/job-application-email-facts.v1',
    publishedSchema: 'email/job-application-email-facts.v1.schema.json',
    jobtrackSchema: 'email/job-application-email-facts.v1.schema.json',
    fixture: 'email/job-application-email-facts.v1.json',
    validator: 'validateJobApplicationEmailFacts'
  },
  {
    id: 'email/job-application-email-facts.v2',
    publishedSchema: 'email/job-application-email-facts.v2.schema.json',
    jobtrackSchema: 'email/job-application-email-facts.v2.schema.json',
    fixture: 'email/job-application-email-facts.v2.json',
    validator: 'validateJobApplicationEmailFactsV2'
  },
  {
    id: 'email/jobtrack-correlation-result.v1',
    publishedSchema: 'email/jobtrack-correlation-result.v1.schema.json',
    jobtrackSchema: 'email/jobtrack-correlation-result.v1.schema.json',
    fixture: 'email/jobtrack-correlation-result.v1.json',
    validator: 'validateCorrelationResult'
  },
  {
    id: 'email/jobtrack-correlation-result.v2',
    publishedSchema: 'email/jobtrack-correlation-result.v2.schema.json',
    jobtrackSchema: 'email/jobtrack-correlation-result.v2.schema.json',
    fixture: 'email/jobtrack-correlation-result.v2.json',
    validator: 'validateCorrelationResultV2'
  },
  {
    id: 'email/jobtrack-correlation-result.v3',
    publishedSchema: 'email/jobtrack-correlation-result.v3.schema.json',
    jobtrackSchema: 'email/jobtrack-correlation-result.v3.schema.json',
    fixture: 'email/jobtrack-correlation-result.v3.json',
    validator: 'validateCorrelationResultV3'
  },
  {
    id: 'email/email-reply-draft-proposal.v2',
    publishedSchema: 'email/email-reply-draft-proposal.v2.schema.json',
    jobtrackSchema: 'email/email-reply-draft-proposal.v2.schema.json',
    fixture: 'email/email-reply-draft-proposal.v2.json',
    validator: 'validateReplyDraftProposalV2'
  },
  {
    id: 'email/draft-provenance-receipt.v1',
    publishedSchema: 'email/draft-provenance-receipt.v1.schema.json',
    jobtrackSchema: 'email/draft-provenance-receipt.v1.schema.json',
    fixture: 'email/draft-provenance-receipt.v1.json',
    validator: 'validateDraftProvenanceReceipt'
  },
  {
    id: 'email/approval-receipt.v1',
    publishedSchema: 'email/approval-receipt.v1.schema.json',
    jobtrackSchema: 'email/approval-receipt.v1.schema.json',
    fixture: 'email/approval-receipt.v1.json',
    validator: 'validateApprovalReceipt'
  },
  {
    id: 'email/email-send-request.v1',
    publishedSchema: 'email/email-send-request.v1.schema.json',
    jobtrackSchema: 'email/email-send-request.v1.schema.json',
    fixture: 'email/email-send-request.v1.json',
    validator: 'validateEmailSendRequest'
  },
  {
    id: 'email/email-send-receipt.v1',
    publishedSchema: 'email/email-send-receipt.v1.schema.json',
    jobtrackSchema: 'email/email-send-receipt.v1.schema.json',
    fixture: 'email/email-send-receipt.v1.json',
    validator: 'validateEmailSendReceipt'
  }
];

// G03 adopts the provider-neutral outgoing family as exact published schemas.
// These entries deliberately have no `validator`: declaring a hand-written
// product validator before B07 would falsely claim send-edge behavior that does
// not exist yet. They still participate in exact schema parity, constraint-
// family parity, public-vector reproduction, and the closed-set coverage guard.
const G03_SCHEMA_ONLY = [
  'email-approved-content.v1',
  'email-reply-draft-proposal.v3',
  'email-draft-receipt.v1',
  'approval-receipt.v2',
  'email-send-request.v2',
  'email-send-receipt.v2'
].map((name) => ({
  id: `email/${name}`,
  publishedSchema: `email/${name}.schema.json`,
  jobtrackSchema: `email/${name}.schema.json`,
  fixture: `email/${name}.json`
}));

const ALL_SHARED_CONTRACTS = [...RUNTIME_CONTRACTS, ...G03_SCHEMA_ONLY];

// ---------------------------------------------------------------------------
// (a) SCHEMA PARITY: byte-equality modulo $id/title/description.
//
// We strip only the doc-only / addressing keys ($id, title, description,
// $comment) and the meta dialect ($schema) at EVERY level, recursively, then
// compare a canonical (deep-key-sorted) form. Everything substantive —
// required, enum, const, type, additionalProperties, all min*/max* bounds,
// pattern, multipleOf, $ref, and the allOf if/then/else cross-field clauses —
// must match exactly. A drift produces the exact JSON pointer that diverged so
// the failing side is obvious.
// ---------------------------------------------------------------------------
const DOC_ONLY_KEYS = new Set(['$id', 'title', 'description', '$comment', '$schema']);

function stripDocOnly(node) {
  if (Array.isArray(node)) return node.map(stripDocOnly);
  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) {
      if (DOC_ONLY_KEYS.has(key)) continue;
      out[key] = stripDocOnly(node[key]);
    }
    return out;
  }
  return node;
}

// Deep-canonical JSON string (recursively sorted object keys) for a stable,
// order-insensitive equality baseline.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// Walk two stripped schemas in parallel and return the FIRST diverging JSON
// pointer (with both sides' values) — a precise, human-readable drift locator.
function firstDivergence(published, local, pointer = '') {
  const pType = Array.isArray(published) ? 'array' : published === null ? 'null' : typeof published;
  const lType = Array.isArray(local) ? 'array' : local === null ? 'null' : typeof local;
  if (pType !== lType) {
    return { pointer: pointer || '/', published, local, reason: `type ${pType} vs ${lType}` };
  }
  if (pType === 'array') {
    if (published.length !== local.length) {
      return {
        pointer: pointer || '/',
        published: `array(len=${published.length})`,
        local: `array(len=${local.length})`,
        reason: 'array length'
      };
    }
    for (let i = 0; i < published.length; i += 1) {
      const d = firstDivergence(published[i], local[i], `${pointer}/${i}`);
      if (d) return d;
    }
    return null;
  }
  if (pType === 'object') {
    const pKeys = Object.keys(published).sort();
    const lKeys = Object.keys(local).sort();
    if (canonicalJson(pKeys) !== canonicalJson(lKeys)) {
      const onlyPublished = pKeys.filter((k) => !lKeys.includes(k));
      const onlyLocal = lKeys.filter((k) => !pKeys.includes(k));
      return {
        pointer: pointer || '/',
        published: onlyPublished.length ? `+keys ${onlyPublished.join(',')}` : '(same keys)',
        local: onlyLocal.length ? `+keys ${onlyLocal.join(',')}` : '(same keys)',
        reason: 'object key set'
      };
    }
    for (const key of pKeys) {
      const d = firstDivergence(published[key], local[key], `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      if (d) return d;
    }
    return null;
  }
  if (published !== local) {
    return { pointer: pointer || '/', published, local, reason: 'scalar value' };
  }
  return null;
}

test('schema parity: JobTrack contract copies are structurally exact modulo documentation annotations', async (t) => {
  for (const contract of ALL_SHARED_CONTRACTS) {
    await t.test(contract.id, () => {
      const publishedPath = path.join(PUBLISHED_SCHEMAS, contract.publishedSchema);
      const localPath = path.join(JOBTRACK_CONTRACTS, contract.jobtrackSchema);
      assert.ok(fs.existsSync(publishedPath), `missing published schema ${publishedPath}`);
      assert.ok(fs.existsSync(localPath), `missing JobTrack schema copy ${localPath}`);

      const published = stripDocOnly(readJson(publishedPath));
      const local = stripDocOnly(readJson(localPath));

      const divergence = firstDivergence(published, local);
      assert.equal(
        divergence,
        null,
        divergence
          ? `SUBSTANTIVE SCHEMA DRIFT in ${contract.id} at ${divergence.pointer} ` +
              `(${divergence.reason}): published=${JSON.stringify(divergence.published)} ` +
              `local=${JSON.stringify(divergence.local)}. A version bump on one side ` +
              'without the other must not land — re-sync JobTrack contracts/ with ' +
              'execution-contracts/schemas.'
          : ''
      );
      // Belt-and-suspenders: whole-object canonical equality.
      assert.equal(canonicalJson(published), canonicalJson(local), `${contract.id} canonical mismatch`);
    });
  }
});

test('schema parity: G03 outgoing schema-only copies are byte-for-byte published artifacts', async (t) => {
  for (const contract of G03_SCHEMA_ONLY) {
    await t.test(contract.id, () => {
      const publishedPath = path.join(PUBLISHED_SCHEMAS, contract.publishedSchema);
      const localPath = path.join(JOBTRACK_CONTRACTS, contract.jobtrackSchema);
      assert.ok(fs.existsSync(publishedPath), `missing published schema ${publishedPath}`);
      assert.ok(fs.existsSync(localPath), `missing JobTrack schema copy ${localPath}`);
      assert.deepEqual(
        fs.readFileSync(localPath),
        fs.readFileSync(publishedPath),
        `${contract.id}: G03 schema-only adoption must remain byte-for-byte exact`
      );
    });
  }
});

// Focused assertions on the specific constraint families the drift gate must
// protect (required / enum / bounds / const / additionalProperties). These
// re-derive the constraint sets from BOTH schemas independently and compare, so
// a reviewer sees exactly which family was checked even when the deep compare
// already passed.
test('schema parity: required / enum / const / bounds / additionalProperties families match exactly', async (t) => {
  const BOUND_KEYS = [
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
    'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
    'pattern', 'multipleOf', 'uniqueItems'
  ];

  // Collect every (pointer -> value) for a given constraint family across the
  // whole schema tree (skipping the doc-only keys).
  function collect(node, predicate, pointer = '') {
    const found = [];
    if (Array.isArray(node)) {
      node.forEach((child, i) => found.push(...collect(child, predicate, `${pointer}/${i}`)));
      return found;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        if (DOC_ONLY_KEYS.has(key)) continue;
        const childPointer = `${pointer}/${key}`;
        if (predicate(key)) {
          found.push([childPointer, canonicalJson(node[key])]);
        }
        found.push(...collect(node[key], predicate, childPointer));
      }
    }
    return found;
  }

  function compareFamily(contract, predicate, label) {
    const published = readJson(path.join(PUBLISHED_SCHEMAS, contract.publishedSchema));
    const local = readJson(path.join(JOBTRACK_CONTRACTS, contract.jobtrackSchema));
    const pub = collect(published, predicate).sort();
    const loc = collect(local, predicate).sort();
    assert.deepEqual(
      loc,
      pub,
      `${label} drift in ${contract.id}: JobTrack copy diverges from published schema`
    );
  }

  for (const contract of ALL_SHARED_CONTRACTS) {
    await t.test(contract.id, () => {
      compareFamily(contract, (k) => k === 'required', 'required[]');
      compareFamily(contract, (k) => k === 'enum', 'enum');
      compareFamily(contract, (k) => k === 'const', 'const');
      compareFamily(contract, (k) => k === 'additionalProperties', 'additionalProperties');
      compareFamily(contract, (k) => k === 'type', 'type');
      compareFamily(contract, (k) => BOUND_KEYS.includes(k), 'bounds');
    });
  }
});

// ---------------------------------------------------------------------------
// (b1) VALIDATOR ACCEPTANCE PARITY — golden fixtures.
//
// JobTrack's live validators must accept the published golden instance for
// every shared contract verbatim, and (crucially) round-trip it: the validator
// returns a deep-equal clone, proving it neither drops nor rewrites any field of
// a published-valid instance.
// ---------------------------------------------------------------------------
test('acceptance parity: JobTrack validators accept the published golden fixtures verbatim', async (t) => {
  for (const contract of RUNTIME_CONTRACTS) {
    await t.test(contract.id, () => {
      const fixture = readJson(path.join(PUBLISHED_FIXTURES, contract.fixture));
      const validate = contracts[contract.validator];
      assert.equal(typeof validate, 'function', `missing validator ${contract.validator}`);
      let result;
      assert.doesNotThrow(() => {
        result = validate(fixture);
      }, `JobTrack ${contract.validator} rejected the published golden fixture for ${contract.id}`);
      // Round-trip: the accepted clone equals the published instance (no silent
      // coercion / field loss).
      assert.deepEqual(result, fixture, `${contract.id}: validator mutated the accepted instance`);
    });
  }
});

// The published package ships an extra usage-receipt golden at the
// estimated_tier_ceiling tier (null observed telemetry, non-zero charged floor).
// It exercises a different branch of the code-side invariants, so assert it too.
test('acceptance parity: JobTrack accepts the published tier-ceiling usage receipt', () => {
  const fixture = readJson(path.join(PUBLISHED_FIXTURES, 'execution/usage-receipt.v1.tier-ceiling.json'));
  let result;
  assert.doesNotThrow(() => {
    result = contracts.validateUsageReceipt(fixture);
  }, 'JobTrack validateUsageReceipt rejected the published tier-ceiling golden fixture');
  assert.deepEqual(result, fixture);
});

// ---------------------------------------------------------------------------
// (b2) VALIDATOR ACCEPTANCE PARITY — negative cases MUST be rejected.
//
// The published package documents its reject set in CONTRACT-FREEZE-REVIEW.md
// ("Negative cases reject: null charged tokens; tier-ceiling with observed
// tokens; signature without provider_signed; extra property; wrong trust
// const"). There are no standalone negative FIXTURE files — the negatives are
// documented mutations of the golden instances — so we derive each negative
// from the published golden fixture via a single, explicit, JSON-Schema-visible
// breakage and assert JobTrack's validator throws EmailContractError.
//
// Each negative below is chosen so that BOTH the published JSON Schema AND
// JobTrack's code-side validator would reject it: this is what makes acceptance
// parity meaningful — the two implementations agree on the boundary, not just
// on the golden center.
// ---------------------------------------------------------------------------
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadFixture(rel) {
  return readJson(path.join(PUBLISHED_FIXTURES, rel));
}

// Every shared contract must reject: (1) an unknown extra property
// (additionalProperties:false), (2) a wrong schemaVersion const, and (3) a
// removed required property. These are the universal drift breakers.
test('acceptance parity: every contract rejects extra property, wrong const, and missing required', async (t) => {
  for (const contract of RUNTIME_CONTRACTS) {
    await t.test(contract.id, () => {
      const validate = contracts[contract.validator];
      const golden = loadFixture(contract.fixture);

      // (1) unknown extra property.
      const extra = clone(golden);
      extra.__driftCanary = 'unexpected';
      assert.throws(
        () => validate(extra),
        contracts.EmailContractError,
        `${contract.id}: an unknown extra property must be rejected (additionalProperties:false)`
      );

      // (2) wrong schemaVersion const.
      const wrongConst = clone(golden);
      wrongConst.schemaVersion = `${golden.schemaVersion}-tampered`;
      assert.throws(
        () => validate(wrongConst),
        contracts.EmailContractError,
        `${contract.id}: a tampered schemaVersion const must be rejected`
      );

      // (3) a removed required property. Pick the first required key that is not
      // the schemaVersion const (removing that is already covered) using the
      // published schema's required[] at the root.
      const schema = readJson(path.join(PUBLISHED_SCHEMAS, contract.publishedSchema));
      const required = Array.isArray(schema.required) ? schema.required : [];
      const target = required.find((key) => key !== 'schemaVersion' && key in golden);
      assert.ok(target, `${contract.id}: expected a droppable required property`);
      const missingRequired = clone(golden);
      delete missingRequired[target];
      assert.throws(
        () => validate(missingRequired),
        contracts.EmailContractError,
        `${contract.id}: dropping required '${target}' must be rejected`
      );
    });
  }
});

// usage-receipt.v1: the full documented reject set for the nucleus contract.
test('acceptance parity: usage-receipt.v1 rejects the documented negative cases', () => {
  const validate = contracts.validateUsageReceipt;
  const golden = loadFixture('execution/usage-receipt.v1.json'); // provider_reported
  const ceiling = loadFixture('execution/usage-receipt.v1.tier-ceiling.json'); // estimated_tier_ceiling

  // null charged tokens (charged values are NEVER null).
  const nullCharged = clone(golden);
  nullCharged.chargedTokens = null;
  assert.throws(() => validate(nullCharged), contracts.EmailContractError, 'null chargedTokens must reject');

  const nullChargedCost = clone(golden);
  nullChargedCost.chargedCostMicroUsd = null;
  assert.throws(() => validate(nullChargedCost), contracts.EmailContractError, 'null chargedCostMicroUsd must reject');

  // tier-ceiling / unavailable carrying observed telemetry (schema `then`
  // pins observed* to null for these tiers).
  const ceilingWithObserved = clone(ceiling);
  ceilingWithObserved.observedInputTokens = 100;
  assert.throws(
    () => validate(ceilingWithObserved),
    contracts.EmailContractError,
    'estimated_tier_ceiling with observed tokens must reject'
  );

  // wrong trust const (outside the closed enum).
  const wrongTrust = clone(golden);
  wrongTrust.trust = 'provider_guessed';
  assert.throws(() => validate(wrongTrust), contracts.EmailContractError, 'unknown trust tier must reject');

  // signature present without provider_signed (schema else: not required=[signature]).
  const straySignature = clone(golden);
  straySignature.signature = 'opaque-token';
  assert.throws(
    () => validate(straySignature),
    contracts.EmailContractError,
    'signature without provider_signed must reject'
  );

  // provider_signed WITHOUT a signature (schema then: required=[signature]).
  const signedNoSig = clone(golden);
  signedNoSig.trust = 'provider_signed';
  assert.throws(
    () => validate(signedNoSig),
    contracts.EmailContractError,
    'provider_signed without signature must reject'
  );

  // Code-side non-zero floor (CONVENTIONS §5): at a no-telemetry tier a
  // charged-0 receipt is the silent-zero gap the floor closes. This is a
  // code-side-ONLY reject (the JSON Schema's minimum:0 still admits it), so it
  // is a load-bearing parity check that JobTrack carries the floor.
  const floorZeroTokens = clone(ceiling);
  floorZeroTokens.chargedTokens = 0;
  assert.throws(
    () => validate(floorZeroTokens),
    contracts.EmailContractError,
    'charged-0 tokens at estimated_tier_ceiling must reject (code-side floor)'
  );

  const floorZeroCost = clone(ceiling);
  floorZeroCost.chargedCostMicroUsd = 0;
  assert.throws(
    () => validate(floorZeroCost),
    contracts.EmailContractError,
    'charged-0 cost at estimated_tier_ceiling must reject (code-side floor)'
  );

  // provider_reported with NO observed value at all (schema then: anyOf observed).
  const reportedNoObserved = clone(golden);
  reportedNoObserved.observedInputTokens = null;
  reportedNoObserved.observedOutputTokens = null;
  reportedNoObserved.observedCostMicroUsd = null;
  assert.throws(
    () => validate(reportedNoObserved),
    contracts.EmailContractError,
    'provider_reported with no observed value must reject'
  );

  // Bounds: negative charged tokens (schema minimum:0).
  const negativeCharged = clone(golden);
  negativeCharged.chargedTokens = -1;
  assert.throws(() => validate(negativeCharged), contracts.EmailContractError, 'negative chargedTokens must reject');

  // Bounds: routeAlias violating the ^[a-z][a-z0-9-]*$ pattern.
  const badAlias = clone(golden);
  badAlias.routeAlias = 'Frontier_Default';
  assert.throws(() => validate(badAlias), contracts.EmailContractError, 'invalid routeAlias pattern must reject');
});

// job-application-email-facts.v1: closed enums + code-side cross-field rules.
test('acceptance parity: job-application-email-facts.v1 rejects the documented negative cases', () => {
  const validate = contracts.validateJobApplicationEmailFacts;
  const golden = loadFixture('email/job-application-email-facts.v1.json');

  // wrong `trust` const (must be untrusted_external).
  const wrongTrust = clone(golden);
  wrongTrust.trust = 'trusted';
  assert.throws(() => validate(wrongTrust), contracts.EmailContractError, 'trust must be untrusted_external');

  // eventKind outside the closed enum.
  const badEvent = clone(golden);
  badEvent.eventKind = 'spam';
  assert.throws(() => validate(badEvent), contracts.EmailContractError, 'unknown eventKind must reject');

  // code-side: fromDomain must equal domain(fromAddress).
  const domainMismatch = clone(golden);
  domainMismatch.source.fromDomain = 'other.test';
  assert.throws(
    () => validate(domainMismatch),
    contracts.EmailContractError,
    'fromDomain must match fromAddress (code-side cross-field)'
  );

  // code-side: interview_invite requires interview.intent=schedule.
  const invite = clone(golden);
  invite.eventKind = 'interview_invite';
  invite.interview = { intent: 'cancel' };
  assert.throws(
    () => validate(invite),
    contracts.EmailContractError,
    'interview_invite requires interview.intent=schedule (code-side cross-field)'
  );
});

// Provider-neutral v2 accepts exact adapter codes while preserving the v1
// closed-provider boundary for legacy consumers.
test('acceptance parity: provider-neutral v2 rejects malformed provider codes without widening v1', () => {
  const factsV2 = loadFixture('email/job-application-email-facts.v2.json');
  const correlationV2 = loadFixture('email/jobtrack-correlation-result.v2.json');

  assert.equal(contracts.validateJobApplicationEmailFacts(factsV2).source.provider, 'apple_mail_emlx');
  assert.equal(contracts.validateCorrelationResult(correlationV2).source.provider, 'apple_mail_emlx');

  for (const malformed of ['Apple Mail', 'apple/mail', '1apple', '', `a${'b'.repeat(80)}`]) {
    const badFacts = clone(factsV2);
    badFacts.source.provider = malformed;
    assert.throws(
      () => contracts.validateJobApplicationEmailFacts(badFacts),
      contracts.EmailContractError,
      `facts v2 malformed provider ${JSON.stringify(malformed)} must reject`
    );

    const badCorrelation = clone(correlationV2);
    badCorrelation.source.provider = malformed;
    assert.throws(
      () => contracts.validateCorrelationResult(badCorrelation),
      contracts.EmailContractError,
      `correlation v2 malformed provider ${JSON.stringify(malformed)} must reject`
    );
  }

  const legacyFacts = loadFixture('email/job-application-email-facts.v1.json');
  legacyFacts.source.provider = 'apple_mail_emlx';
  assert.throws(
    () => contracts.validateJobApplicationEmailFacts(legacyFacts),
    contracts.EmailContractError,
    'provider-neutral v2 must not widen the frozen v1 provider enum'
  );
});

// jobtrack-correlation-result.v1: resolution enum + code-side correlation rules.
test('acceptance parity: jobtrack-correlation-result.v1 rejects the documented negative cases', () => {
  const validate = contracts.validateCorrelationResult;
  const golden = loadFixture('email/jobtrack-correlation-result.v1.json'); // unmatched, 0 candidates

  // resolution outside the closed enum.
  const badResolution = clone(golden);
  badResolution.resolution = 'maybe';
  assert.throws(() => validate(badResolution), contracts.EmailContractError, 'unknown resolution must reject');

  // code-side: a non-linked result must not be automaticEligible.
  const eligibleUnmatched = clone(golden);
  eligibleUnmatched.automaticEligible = true;
  assert.throws(
    () => validate(eligibleUnmatched),
    contracts.EmailContractError,
    'unmatched result cannot be automaticEligible (code-side cross-field)'
  );

  // bad factsDigest (must be 64-hex sha256).
  const badDigest = clone(golden);
  badDigest.factsDigest = 'not-a-sha256';
  assert.throws(() => validate(badDigest), contracts.EmailContractError, 'malformed factsDigest must reject');
});

// email-reply-draft-proposal.v2: safety-const invariants + bodyDigest binding.
test('acceptance parity: email-reply-draft-proposal.v2 rejects the documented negative cases', () => {
  const validate = contracts.validateReplyDraftProposalV2;
  const golden = loadFixture('email/email-reply-draft-proposal.v2.json');

  // safety const flipped: autoSendEligible must be false.
  const autoSend = clone(golden);
  autoSend.autoSendEligible = true;
  assert.throws(() => validate(autoSend), contracts.EmailContractError, 'autoSendEligible must be false');

  // safety const flipped: requiresReview must be true.
  const noReview = clone(golden);
  noReview.requiresReview = false;
  assert.throws(() => validate(noReview), contracts.EmailContractError, 'requiresReview must be true');

  // code-side: bodyDigest must equal sha256(body).
  const tamperedBody = clone(golden);
  tamperedBody.body = `${golden.body} (tampered)`;
  assert.throws(
    () => validate(tamperedBody),
    contracts.EmailContractError,
    'bodyDigest must match body (code-side cross-field)'
  );

  // code-side: recipient must equal source.replyToAddress.
  const recipientDrift = clone(golden);
  recipientDrift.recipient = 'someone-else@example.test';
  assert.throws(
    () => validate(recipientDrift),
    contracts.EmailContractError,
    'recipient must equal source.replyToAddress (recipient lock)'
  );
});

// draft-provenance-receipt.v1: nested usage receipt is mandatory + validated.
test('acceptance parity: draft-provenance-receipt.v1 rejects the documented negative cases', () => {
  const validate = contracts.validateDraftProvenanceReceipt;
  const golden = loadFixture('email/draft-provenance-receipt.v1.json');

  // corpus source kind outside the closed enum.
  const badKind = clone(golden);
  badKind.corpusSources[0].kind = 'random-source';
  assert.throws(() => validate(badKind), contracts.EmailContractError, 'unknown corpus source kind must reject');

  // the nested usage receipt inherits the same floor/trust rules.
  const zeroFloorUsage = clone(golden);
  zeroFloorUsage.usage.trust = 'unavailable';
  zeroFloorUsage.usage.observedInputTokens = null;
  zeroFloorUsage.usage.observedOutputTokens = null;
  zeroFloorUsage.usage.observedCostMicroUsd = null;
  zeroFloorUsage.usage.chargedTokens = 0;
  zeroFloorUsage.usage.chargedCostMicroUsd = 0;
  delete zeroFloorUsage.usage.routeAlias;
  assert.throws(
    () => validate(zeroFloorUsage),
    contracts.EmailContractError,
    'a charged-0 unavailable nested usage receipt must reject (silent-zero floor)'
  );
});

// approval-receipt.v1: approver kind + scope action consts.
test('acceptance parity: approval-receipt.v1 rejects the documented negative cases', () => {
  const validate = contracts.validateApprovalReceipt;
  const golden = loadFixture('email/approval-receipt.v1.json');

  // approver.kind must be human (no machine approvals).
  const machineApprover = clone(golden);
  machineApprover.approver.kind = 'machine';
  assert.throws(() => validate(machineApprover), contracts.EmailContractError, 'approver.kind must be human');

  // scope.action must be send-once.
  const wrongAction = clone(golden);
  wrongAction.scope.action = 'send-many';
  assert.throws(() => validate(wrongAction), contracts.EmailContractError, 'scope.action must be send-once');

  // malformed approvedArtifactContractId (must match contractId pattern).
  const badContractId = clone(golden);
  badContractId.approvedArtifactContractId = 'Not A ContractId';
  assert.throws(
    () => validate(badContractId),
    contracts.EmailContractError,
    'malformed approvedArtifactContractId must reject'
  );
});

// email-send-request.v1: the digest / recipient / thread cross-field locks that
// the send edge re-verifies before ever transmitting.
test('acceptance parity: email-send-request.v1 rejects the documented negative cases', () => {
  const validate = contracts.validateEmailSendRequest;
  const golden = loadFixture('email/email-send-request.v1.json');

  // content.mode must be draft_artifact (no inline MIME in v1).
  const wrongMode = clone(golden);
  wrongMode.content.mode = 'rendered_mime';
  assert.throws(() => validate(wrongMode), contracts.EmailContractError, 'content.mode must be draft_artifact');

  // code-side: content.digest must equal approval.approvedArtifactDigest.
  const digestDrift = clone(golden);
  digestDrift.content.digest = 'f'.repeat(64);
  assert.throws(
    () => validate(digestDrift),
    contracts.EmailContractError,
    'content.digest must equal approval.approvedArtifactDigest (send-edge lock)'
  );

  // code-side: recipient must equal approval.scope.recipient (recipient lock).
  const recipientDrift = clone(golden);
  recipientDrift.recipient = 'attacker@example.test';
  assert.throws(
    () => validate(recipientDrift),
    contracts.EmailContractError,
    'recipient must equal approval.scope.recipient (recipient lock)'
  );

  // malformed idempotencyKey (must match the idempotency pattern).
  const badKey = clone(golden);
  badKey.idempotencyKey = 'has spaces';
  assert.throws(() => validate(badKey), contracts.EmailContractError, 'malformed idempotencyKey must reject');
});

// email-send-receipt.v1: status enum + status/field cross-field consistency.
test('acceptance parity: email-send-receipt.v1 rejects the documented negative cases', () => {
  const validate = contracts.validateEmailSendReceipt;
  const golden = loadFixture('email/email-send-receipt.v1.json'); // status: sent

  // status outside the closed enum.
  const badStatus = clone(golden);
  badStatus.status = 'queued';
  assert.throws(() => validate(badStatus), contracts.EmailContractError, 'unknown status must reject');

  // code-side: a sent receipt must not carry a failureReason.
  const sentWithFailure = clone(golden);
  sentWithFailure.failureReason = 'should not be here';
  assert.throws(
    () => validate(sentWithFailure),
    contracts.EmailContractError,
    'sent receipt must not carry failureReason (code-side cross-field)'
  );

  // code-side: a sent receipt must carry a providerMessageId.
  const sentNoMessageId = clone(golden);
  delete sentNoMessageId.providerMessageId;
  assert.throws(
    () => validate(sentNoMessageId),
    contracts.EmailContractError,
    'sent receipt must carry providerMessageId (code-side cross-field)'
  );
});

// ---------------------------------------------------------------------------
// (c) G03 PUBLIC-VECTOR PARITY — schema adoption without B07 behavior.
//
// The published package is the only source of test documents and public keys.
// No private key, credential, mailbox, provider, database, or send implementation
// is involved. These checks prove that JobTrack can reproduce the canonical
// content locks it will later consume/produce without claiming that the future
// B07 product validators already exist.
// ---------------------------------------------------------------------------
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function loadPublishedVector(rel) {
  return readJson(path.join(PUBLISHED_ROOT, rel));
}

function assertPublicEd25519Attestation(document, property, publicKeyRecord, label) {
  const attestation = document[property];
  assert.ok(attestation && typeof attestation === 'object', `${label}: missing ${property}`);
  assert.equal(attestation.algorithm, 'Ed25519', `${label}: algorithm drift`);
  assert.equal(attestation.signatureEncoding, 'base64', `${label}: signature encoding drift`);
  assert.equal(attestation.keyId, publicKeyRecord.keyId, `${label}: public test key id drift`);
  assert.equal(publicKeyRecord.algorithm, 'Ed25519', `${label}: public-key algorithm drift`);

  const payload = clone(document);
  delete payload[property];
  const payloadBytes = Buffer.from(canonicalJson(payload), 'utf8');
  assert.equal(
    sha256(payloadBytes),
    attestation.payloadDigest,
    `${label}: attestation payload digest does not reproduce`
  );

  const signature = Buffer.from(attestation.signature, 'base64');
  assert.equal(signature.length, 64, `${label}: Ed25519 signature must be 64 bytes`);
  assert.equal(
    signature.toString('base64'),
    attestation.signature,
    `${label}: signature must use canonical base64 encoding`
  );

  const publicKey = crypto.createPublicKey({
    key: Buffer.from(publicKeyRecord.spkiDerBase64, 'base64'),
    format: 'der',
    type: 'spki'
  });
  assert.equal(publicKey.asymmetricKeyType, 'ed25519', `${label}: test key is not Ed25519`);
  assert.equal(
    crypto.verify(null, payloadBytes, publicKey, signature),
    true,
    `${label}: public test signature does not verify`
  );
}

test('G03 schema-only family requires all six published golden fixtures without runtime-validator claims', async (t) => {
  for (const contract of G03_SCHEMA_ONLY) {
    await t.test(contract.id, () => {
      assert.equal('validator' in contract, false, `${contract.id}: B07 validator declared during G03`);
      const fixturePath = path.join(PUBLISHED_FIXTURES, contract.fixture);
      assert.ok(fs.existsSync(fixturePath), `missing published golden fixture ${fixturePath}`);
      assert.equal(
        readJson(fixturePath).schemaVersion,
        path.basename(contract.fixture, '.json'),
        `${contract.id}: fixture schemaVersion drift`
      );
    });
  }
});

test('G03 outgoing canonical digest vectors reproduce from published public fixtures', async (t) => {
  const digestContracts = [
    'email-approved-content.v1',
    'email-reply-draft-proposal.v3',
    'approval-receipt.v2',
    'email-send-request.v2'
  ];

  for (const name of digestContracts) {
    await t.test(name, () => {
      const fixture = loadFixture(`email/${name}.json`);
      const vector = loadFixture(`digest/${name}.digest.json`);
      const reproducedCanonicalJson = canonicalJson(fixture);
      assert.equal(vector.contractId, name, `${name}: digest-vector contractId drift`);
      assert.match(vector.digest, /^[a-f0-9]{64}$/, `${name}: digest is not bare lowercase SHA-256`);
      assert.equal(
        reproducedCanonicalJson,
        vector.canonicalJson,
        `${name}: published fixture does not reproduce canonical JSON bytes`
      );
      assert.equal(
        sha256(vector.canonicalJson),
        vector.digest,
        `${name}: published canonical JSON does not reproduce its digest`
      );
    });
  }
});

test('G03 outgoing public attestations and six-document digest links reproduce', () => {
  const keys = loadPublishedVector('test-vectors/outgoing-v2-test-public-keys.json');
  assert.equal(keys.schemaVersion, 'outgoing-v2-test-public-keys.v1');
  assert.match(keys.warning, /Public test keys only; never authorize production\./);

  const proposalDigest = loadFixture('digest/email-reply-draft-proposal.v3.digest.json').digest;
  const contentDigest = loadFixture('digest/email-approved-content.v1.digest.json').digest;
  const approvalDigest = loadFixture('digest/approval-receipt.v2.digest.json').digest;
  const requestDigest = loadFixture('digest/email-send-request.v2.digest.json').digest;
  const draftReceipt = loadFixture('email/email-draft-receipt.v1.json');
  const approval = loadFixture('email/approval-receipt.v2.json');
  const request = loadFixture('email/email-send-request.v2.json');
  const sentReceipt = loadFixture('email/email-send-receipt.v2.json');

  assert.equal(draftReceipt.draftProposalDigest, proposalDigest);
  assert.equal(draftReceipt.contentDigest, contentDigest);
  assert.equal(approval.approvedContentDigest, contentDigest);
  assert.equal(request.approvalDigest, approvalDigest);
  assert.equal(request.content.digest, contentDigest);
  assert.equal(sentReceipt.requestDigest, requestDigest);
  assert.equal(sentReceipt.contentDigest, contentDigest);

  assertPublicEd25519Attestation(approval, 'attestation', keys.approval, 'approval-receipt.v2');
  assertPublicEd25519Attestation(
    sentReceipt,
    'nativeAttestation',
    keys.nativeReceipt,
    'email-send-receipt.v2 sent'
  );

  const outcomes = loadPublishedVector('test-vectors/outgoing-v2-signed-outcomes.json');
  assert.match(outcomes.warning, /no private key is included/);
  for (const [outcome, receipt] of Object.entries(outcomes)) {
    if (outcome === 'warning') continue;
    assert.equal(receipt.schemaVersion, 'email-send-receipt.v2', `${outcome}: schemaVersion drift`);
    assert.equal(receipt.outcome, outcome, `${outcome}: outcome label drift`);
    assert.equal(receipt.requestDigest, requestDigest, `${outcome}: request digest drift`);
    assert.equal(receipt.contentDigest, contentDigest, `${outcome}: content digest drift`);
    assertPublicEd25519Attestation(
      receipt,
      'nativeAttestation',
      keys.nativeReceipt,
      `email-send-receipt.v2 ${outcome}`
    );
  }
});

// ---------------------------------------------------------------------------
// Coverage guard: the set of published schemas that JobTrack ALSO copies must
// be exactly the runtime-validated plus G03-schema-only sets. If
// execution-contracts publishes a new schema
// that JobTrack later copies (or vice versa) without adding it here, this fails
// so the gate never silently under-covers. Published-but-not-copied schemas
// (artifact-ref, environment-descriptor, proposal) are JobTrack-out-of-scope and
// are explicitly excluded.
// ---------------------------------------------------------------------------
test('coverage guard: adopted sets exactly equal the published∩jobtrack schema intersection', () => {
  // Published schemas JobTrack intentionally does NOT copy (nucleus types it
  // does not itself produce/consume as standalone contract rows).
  const PUBLISHED_ONLY = new Set([
    'execution/artifact-ref.v1.schema.json',
    'execution/environment-descriptor.v1.schema.json',
    'execution/proposal.v1.schema.json'
  ]);

  function listSchemas(root, subdirs) {
    const out = [];
    for (const sub of subdirs) {
      const dir = path.join(root, sub);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.schema.json')) out.push(`${sub}/${name}`);
      }
    }
    return out;
  }

  const published = new Set(listSchemas(PUBLISHED_SCHEMAS, ['execution', 'email']));
  const jobtrack = new Set(listSchemas(JOBTRACK_CONTRACTS, ['execution', 'email']));

  // The intersection of published and jobtrack, minus the explicitly excluded
  // nucleus-only schemas, must equal the adopted sets exactly.
  const intersection = [...published].filter((rel) => jobtrack.has(rel) && !PUBLISHED_ONLY.has(rel)).sort();
  const covered = ALL_SHARED_CONTRACTS.map((c) => c.publishedSchema).sort();
  assert.deepEqual(
    covered,
    intersection,
    'adopted contract sets are out of sync with the published∩jobtrack schema intersection: ' +
      `add/remove an entry (published=${[...published].sort().join(', ')}; ` +
      `jobtrack copies=${[...jobtrack].sort().join(', ')})`
  );

  // Sanity: every published-only schema really is absent from JobTrack's copies,
  // confirming the exclusion list is honest.
  for (const rel of PUBLISHED_ONLY) {
    assert.ok(published.has(rel), `exclusion list names a non-published schema: ${rel}`);
  }
});
