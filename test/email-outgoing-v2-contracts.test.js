'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const contracts = require('../lib/email-contracts');
const outgoing = require('../lib/email-outgoing-v2-contracts');
const {
  emailFixtures,
  manifest,
  negativeFixtures,
  testVectors,
  verifyPinnedOutgoingV2Fixtures
} = require('../test-support/outgoing-v2-fixtures');

verifyPinnedOutgoingV2Fixtures();

test('outgoing contract fixtures are repository-local and content-addressed to one reviewed source tree', () => {
  assert.equal(verifyPinnedOutgoingV2Fixtures(), true);
  // REVIEWED REPIN (2026-09-02): execution-contracts 1.7.0 adds only the
  // policy-stamped JobTrack correlation-result v3 family; outgoing bytes are unchanged.
  assert.equal(manifest.sourceCommit, 'bd7e1f627a86b318b424ca81aee1d5658795f042');
  assert.equal(manifest.sourceTree, '7db0b6c67a18eb5af0b241281b829609cf760c64');
  assert.equal(JSON.stringify(manifest).includes('/Users/'), false);
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fixture(name) {
  return readJson(path.join(emailFixtures, `${name}.json`));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function publicKeys() {
  const records = readJson(path.join(testVectors, 'outgoing-v2-test-public-keys.json'));
  const decode = (record) => crypto.createPublicKey({
    key: Buffer.from(record.spkiDerBase64, 'base64'),
    format: 'der',
    type: 'spki'
  });
  return {
    approval: { record: records.approval, key: decode(records.approval) },
    native: { record: records.nativeReceipt, key: decode(records.nativeReceipt) }
  };
}

function keyOptions(record, key, calls = null) {
  return {
    expectedKeyId: record.keyId,
    expectedPublicKeySha256: crypto.createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' }))
      .digest('hex'),
    resolvePublicKey(keyId) {
      if (calls) calls.count += 1;
      return keyId === record.keyId ? key.export({ type: 'spki', format: 'pem' }) : null;
    }
  };
}

function claimBundle() {
  return {
    proposal: fixture('email-reply-draft-proposal.v3'),
    content: fixture('email-approved-content.v1'),
    draftReceipt: fixture('email-draft-receipt.v1'),
    approval: fixture('approval-receipt.v2'),
    request: fixture('email-send-request.v2')
  };
}

test('provider-neutral validators accept all published goldens, including dense references and empty attachments', () => {
  const cases = [
    ['email-reply-draft-proposal.v3', 'validateReplyDraftProposalV3'],
    ['email-approved-content.v1', 'validateEmailApprovedContentV1'],
    ['email-draft-receipt.v1', 'validateEmailDraftReceiptV1'],
    ['approval-receipt.v2', 'validateApprovalReceiptV2'],
    ['email-send-request.v2', 'validateEmailSendRequestV2'],
    ['email-send-receipt.v2', 'validateEmailSendReceiptV2']
  ];
  for (const [name, validator] of cases) {
    const value = fixture(name);
    const validated = contracts[validator](value);
    assert.deepEqual(validated, value, name);
    assert.equal(Object.isFrozen(validated), true, `${name} root is an immutable snapshot`);
  }
  assert.deepEqual(contracts.validateReplyDraftProposalV3(fixture('email-reply-draft-proposal.v3')).source.references, ['<apple-message-1@example.test>']);
  assert.deepEqual(contracts.validateEmailApprovedContentV1(fixture('email-approved-content.v1')).attachments, []);
});

test('published mutation negatives are rejected by the corresponding JobTrack validator', () => {
  const cases = [
    ['email-reply-draft-proposal.v3', 'validateReplyDraftProposalV3'],
    ['email-approved-content.v1', 'validateEmailApprovedContentV1'],
    ['email-draft-receipt.v1', 'validateEmailDraftReceiptV1'],
    ['approval-receipt.v2', 'validateApprovalReceiptV2'],
    ['email-send-request.v2', 'validateEmailSendRequestV2'],
    ['email-send-receipt.v2', 'validateEmailSendReceiptV2']
  ];
  for (const [name, validator] of cases) {
    const negative = readJson(path.join(negativeFixtures, `${name}.negative.json`));
    for (const entry of negative.cases) {
      assert.throws(() => contracts[validator](entry.value), contracts.EmailContractError, `${name}: ${entry.name}`);
    }
  }
});

test('normalization and exact proposal-to-approved-content projection fail closed', () => {
  const proposal = fixture('email-reply-draft-proposal.v3');
  const decomposed = clone(proposal);
  decomposed.subject = 'Re\u0301: Application communication';
  assert.throws(() => contracts.validateReplyDraftProposalV3(decomposed), /Unicode NFC/);

  const crlf = clone(proposal);
  crlf.body = 'one\r\ntwo';
  crlf.bodyDigest = outgoing.digestUtf8Text(outgoing.normalizeBodyV1(crlf.body));
  assert.throws(() => contracts.validateReplyDraftProposalV3(crlf), /LF \+ Unicode NFC normalized/);

  const content = fixture('email-approved-content.v1');
  assert.equal(outgoing.assertProposalContentProjection(proposal, content), true);
  const recipientDrift = clone(content);
  recipientDrift.recipient = 'other@example.test';
  assert.throws(() => outgoing.assertProposalContentProjection(proposal, contracts.validateEmailApprovedContentV1(recipientDrift)), /exact projection/);
});

test('digest domains are explicit and lone UTF-16 surrogates never reach authenticated bytes', () => {
  assert.throws(() => outgoing.digestUtf8Text({}), /requires a string/);
  assert.throws(() => outgoing.digestCanonicalJson('{}'), /requires an object or array root/);
  assert.throws(() => outgoing.digestCanonicalJson(null), /requires an object or array root/);
  assert.equal(outgoing.digestUtf8Text('{}'), crypto.createHash('sha256').update('{}', 'utf8').digest('hex'));
  assert.equal(outgoing.digestCanonicalJson({}), crypto.createHash('sha256').update('{}', 'utf8').digest('hex'));

  const loneHigh = '\ud800';
  const loneLow = '\udc00';
  assert.notEqual(loneHigh, loneLow);
  assert.equal(Buffer.from(loneHigh, 'utf8').toString('hex'), Buffer.from(loneLow, 'utf8').toString('hex'), 'Node replaces both invalid strings with the same UTF-8 bytes');
  for (const invalid of [loneHigh, loneLow]) {
    assert.throws(() => outgoing.digestUtf8Text(invalid), /unpaired UTF-16 surrogate/);
    assert.throws(() => outgoing.digestCanonicalJson({ value: invalid }), /unpaired UTF-16 surrogate/);
    assert.throws(() => outgoing.normalizeBodyV1(invalid), /unpaired UTF-16 surrogate/);
  }
  assert.doesNotThrow(() => outgoing.digestUtf8Text('supplementary scalar: \ud83d\ude80'));

  const signedApproval = fixture('approval-receipt.v2');
  signedApproval.scope.recipient = `recruiter${loneHigh}@example.test`;
  const keys = publicKeys();
  assert.throws(
    () => outgoing.verifyApprovalAttestation(signedApproval, keyOptions(keys.approval.record, keys.approval.key)),
    /unpaired UTF-16 surrogate/
  );
});

test('accessors and Proxies are rejected without invoking their traps', () => {
  const proposal = fixture('email-reply-draft-proposal.v3');
  let getterCalls = 0;
  Object.defineProperty(proposal, 'hidden', {
    enumerable: true,
    get() { getterCalls += 1; return 'boom'; }
  });
  assert.throws(() => contracts.validateReplyDraftProposalV3(proposal), /must not be an accessor/);
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const proxied = new Proxy(fixture('email-approved-content.v1'), {
    ownKeys() { proxyTraps += 1; throw new Error('must not run'); },
    getPrototypeOf() { proxyTraps += 1; throw new Error('must not run'); },
    getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('must not run'); }
  });
  assert.throws(() => contracts.validateEmailApprovedContentV1(proxied), /must not be a Proxy/);
  assert.throws(() => outgoing.stableJson(proxied), /must not be a Proxy/);
  assert.throws(() => outgoing.digestCanonicalJson(proxied), /must not be a Proxy/);
  assert.equal(proxyTraps, 0);

  const keys = publicKeys();
  let optionTraps = 0;
  const optionProxy = new Proxy(keyOptions(keys.approval.record, keys.approval.key), {
    ownKeys() { optionTraps += 1; throw new Error('must not run'); },
    getPrototypeOf() { optionTraps += 1; throw new Error('must not run'); }
  });
  assert.throws(() => outgoing.verifyApprovalAttestation(fixture('approval-receipt.v2'), optionProxy), /must not be a Proxy/);
  assert.equal(optionTraps, 0);

  let keyTraps = 0;
  const resolvedProxy = new Proxy({ publicKey: keys.approval.key }, {
    get() { keyTraps += 1; throw new Error('must not run'); },
    ownKeys() { keyTraps += 1; throw new Error('must not run'); },
    getPrototypeOf() { keyTraps += 1; throw new Error('must not run'); }
  });
  const options = keyOptions(keys.approval.record, keys.approval.key);
  options.resolvePublicKey = () => resolvedProxy;
  assert.throws(() => outgoing.verifyApprovalAttestation(fixture('approval-receipt.v2'), options), /must not be a Proxy/);
  assert.equal(keyTraps, 0);

  let publicKeyGetterCalls = 0;
  const accessorResult = {};
  Object.defineProperty(accessorResult, 'publicKey', {
    enumerable: true,
    get() { publicKeyGetterCalls += 1; return keys.approval.key; }
  });
  options.resolvePublicKey = () => accessorResult;
  assert.throws(() => outgoing.verifyApprovalAttestation(fixture('approval-receipt.v2'), options), /PEM string primitive/);
  assert.equal(publicKeyGetterCalls, 0);

  let consistencyGetterCalls = 0;
  const consistencyOptions = {};
  Object.defineProperty(consistencyOptions, 'phase', {
    enumerable: true,
    get() { consistencyGetterCalls += 1; return 'claim'; }
  });
  assert.match(outgoing.validateOutgoingV2Consistency(claimBundle(), consistencyOptions)[0], /^validation_options_invalid:/);
  assert.equal(consistencyGetterCalls, 0);
});

test('__proto__ data, sparse arrays, oversized arrays, extra bundle fields, and controls fail safely', () => {
  const protoData = JSON.parse('{"__proto__":{"polluted":true},"safe":"value"}');
  assert.equal(outgoing.stableJson(protoData), '{"__proto__":{"polluted":true},"safe":"value"}');
  assert.equal({}.polluted, undefined);

  const sparse = [];
  sparse.length = 4_294_967_295;
  assert.throws(() => outgoing.stableJson(sparse), /array limit|dense array/);

  const extraBundle = { ...claimBundle(), unexpectedAuthority: true };
  const keys = publicKeys();
  const errors = outgoing.validateOutgoingV2Consistency(extraBundle, {
    phase: 'claim',
    now: '2026-08-01T05:41:30.000Z',
    approvalKey: keyOptions(keys.approval.record, keys.approval.key)
  });
  assert.match(errors[0], /^schema_or_contract_invalid:bundle contains unknown field/);

  const nulAccount = fixture('email-approved-content.v1');
  nulAccount.accountId = 'jobs\u0000@example.test';
  assert.throws(() => contracts.validateEmailApprovedContentV1(nulAccount), /control characters/);
  const nulRecipient = fixture('email-approved-content.v1');
  nulRecipient.recipient = 'recruiter\u0000@example.test';
  assert.throws(() => contracts.validateEmailApprovedContentV1(nulRecipient), /without controls/);
  const tabSubject = fixture('email-approved-content.v1');
  tabSubject.subject = 'Re:\tApplication';
  assert.throws(() => contracts.validateEmailApprovedContentV1(tabSubject), /control characters/);
});

test('validated snapshots do not alias caller mutations', () => {
  const input = fixture('email-approved-content.v1');
  const validated = contracts.validateEmailApprovedContentV1(input);
  input.body.text = 'mutated after validation';
  input.thread.references[0] = '<mutated@example.test>';
  assert.equal(validated.body.text, fixture('email-approved-content.v1').body.text);
  assert.deepEqual(validated.thread.references, ['<apple-message-1@example.test>']);
  assert.throws(() => { validated.body.text = 'cannot mutate snapshot'; }, TypeError);
});

test('public Ed25519 vectors verify against raw-SPKI-DER fingerprints', () => {
  const keys = publicKeys();
  const approvalOptions = keyOptions(keys.approval.record, keys.approval.key);
  const nativeOptions = keyOptions(keys.native.record, keys.native.key);
  assert.equal(
    outgoing.publicKeyFingerprint(keys.approval.key.export({ type: 'spki', format: 'pem' })),
    approvalOptions.expectedPublicKeySha256
  );
  assert.equal(outgoing.verifyApprovalAttestation(fixture('approval-receipt.v2'), approvalOptions), true);
  assert.equal(outgoing.verifyNativeReceiptAttestation(fixture('email-send-receipt.v2'), nativeOptions), true);

  const base64TextDigest = crypto.createHash('sha256')
    .update(keys.approval.record.spkiDerBase64, 'utf8')
    .digest('hex');
  assert.notEqual(approvalOptions.expectedPublicKeySha256, base64TextDigest, 'pin hashes raw DER, not its base64 spelling');
});

test('consistency options are snapshotted once and key resolver outputs are cached', () => {
  const keys = publicKeys();
  const approvalCalls = { count: 0 };
  const options = {
    phase: 'claim',
    now: '2026-08-01T05:41:30.000Z',
    approvalKey: keyOptions(keys.approval.record, keys.approval.key, approvalCalls)
  };
  const originalResolver = options.approvalKey.resolvePublicKey;
  options.approvalKey.resolvePublicKey = (keyId) => {
    options.now = '2026-08-01T06:40:00.000Z';
    return originalResolver(keyId);
  };
  assert.deepEqual(outgoing.validateOutgoingV2Consistency(claimBundle(), options), []);
  assert.equal(approvalCalls.count, 1);

  const outcomes = readJson(path.join(testVectors, 'outgoing-v2-signed-outcomes.json'));
  const nativeCalls = { count: 0 };
  const reconciliation = {
    ...claimBundle(),
    sendReceipt: outcomes.duplicate
  };
  const prior = fixture('email-send-receipt.v2');
  const errors = outgoing.validateOutgoingV2Consistency(reconciliation, {
    phase: 'reconciliation',
    now: '2026-08-01T05:43:00.000Z',
    approvalKey: keyOptions(keys.approval.record, keys.approval.key),
    nativeReceiptKey: keyOptions(keys.native.record, keys.native.key, nativeCalls),
    resolvePriorAppliedReceipt: () => prior
  });
  assert.deepEqual(errors, []);
  assert.equal(nativeCalls.count, 1, 'one pinned native key resolution covers receipt and prior receipt');
});

test('expiry is exclusive at approval, request, proposal, and claim boundaries', () => {
  const keys = publicKeys();
  const options = {
    phase: 'claim',
    now: '2026-08-01T06:40:00.000Z',
    approvalKey: keyOptions(keys.approval.record, keys.approval.key)
  };
  const atClaimExpiry = outgoing.validateOutgoingV2Consistency(claimBundle(), options);
  assert.ok(atClaimExpiry.includes('approval_expired'), atClaimExpiry.join(','));

  const approvalAtExpiry = claimBundle();
  approvalAtExpiry.approval.approvedAt = approvalAtExpiry.approval.expiresAt;
  approvalAtExpiry.request.approval = clone(approvalAtExpiry.approval);
  approvalAtExpiry.request.approvalDigest = outgoing.digestCanonicalJson(approvalAtExpiry.approval);
  assert.throws(() => contracts.validateApprovalReceiptV2(approvalAtExpiry.approval), /strictly after/);
  const approvalErrors = outgoing.validateOutgoingV2Consistency(approvalAtExpiry, {
    ...options,
    now: '2026-08-01T06:39:59.000Z'
  });
  assert.match(approvalErrors[0], /^schema_or_contract_invalid:/);

  const requestAtExpiry = claimBundle();
  requestAtExpiry.request.requestedAt = requestAtExpiry.request.expiresAt;
  assert.throws(() => contracts.validateEmailSendRequestV2(requestAtExpiry.request), /strictly before/);
  const requestErrors = outgoing.validateOutgoingV2Consistency(requestAtExpiry, {
    ...options,
    now: '2026-08-01T06:39:59.000Z'
  });
  assert.match(requestErrors[0], /^schema_or_contract_invalid:/);

  const proposalAtExpiry = claimBundle();
  proposalAtExpiry.proposal.expiresAt = proposalAtExpiry.request.requestedAt;
  const proposalErrors = outgoing.validateOutgoingV2Consistency(proposalAtExpiry, {
    ...options,
    now: '2026-08-01T06:39:59.000Z'
  });
  assert.ok(proposalErrors.includes('proposal_expired_before_request'), proposalErrors.join(','));
});

test('generation, manifest, account, recipient, thread, content, channel, signature, and idempotency drift fail closed', () => {
  const keys = publicKeys();
  const options = {
    phase: 'claim',
    now: '2026-08-01T05:41:30.000Z',
    approvalKey: keyOptions(keys.approval.record, keys.approval.key)
  };
  const cases = [
    ['generation', (bundle) => { bundle.proposal.generationId = 'drift-generation'; }, 'proposal_content_projection_mismatch'],
    ['manifest', (bundle) => { bundle.proposal.manifestDigest = 'e'.repeat(64); }, 'proposal_content_projection_mismatch'],
    ['account', (bundle) => { bundle.content.accountId = 'drift@example.test'; }, 'proposal_content_projection_mismatch'],
    ['recipient', (bundle) => { bundle.content.recipient = 'other@example.test'; }, 'proposal_content_projection_mismatch'],
    ['thread', (bundle) => { bundle.content.thread.threadId = 'other-thread'; }, 'proposal_content_projection_mismatch'],
    ['content', (bundle) => {
      bundle.content.body.text = 'Changed logical content.';
      bundle.content.body.digest = outgoing.digestUtf8Text(bundle.content.body.text);
    }, 'proposal_content_projection_mismatch']
  ];
  for (const [name, mutate, expected] of cases) {
    const bundle = claimBundle();
    mutate(bundle);
    const errors = outgoing.validateOutgoingV2Consistency(bundle, options);
    assert.ok(errors.includes(expected), `${name}: ${errors.join(',')}`);
  }

  const idempotency = claimBundle();
  idempotency.request.idempotencyKey = 'drift-idempotency-key';
  assert.match(
    outgoing.validateOutgoingV2Consistency(idempotency, options)[0],
    /^schema_or_contract_invalid:sendRequest.idempotencyKey/
  );

  const unauthenticated = fixture('approval-receipt.v2');
  unauthenticated.authenticatedChannel.authenticated = false;
  assert.throws(() => contracts.validateApprovalReceiptV2(unauthenticated), /must equal true/);

  const badSignature = fixture('approval-receipt.v2');
  badSignature.attestation.signature = `${badSignature.attestation.signature.slice(0, 84)}AA==`;
  assert.throws(() => outgoing.verifyApprovalAttestation(badSignature, options.approvalKey), /signature is invalid/);

  const wrongPin = {
    ...options.approvalKey,
    expectedPublicKeySha256: '0'.repeat(64)
  };
  assert.throws(() => outgoing.verifyApprovalAttestation(fixture('approval-receipt.v2'), wrongPin), /pinned fingerprint/);
});

// A resolver runs before the pinned-fingerprint comparison, so it is attacker
// code positioned to replace any global the later verification path reads. The
// module answers by capturing every such intrinsic at load; these cases prove
// the capture is complete for the globals a forgery would need.
test('a resolver cannot forge verification by poisoning global intrinsics', () => {
  const keys = publicKeys();
  const options = keyOptions(keys.approval.record, keys.approval.key);
  const rogue = crypto.generateKeyPairSync('ed25519');
  const roguePem = rogue.publicKey.export({ type: 'spki', format: 'pem' });
  const rogueFingerprint = crypto.createHash('sha256')
    .update(rogue.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');

  const approval = fixture('approval-receipt.v2');
  const { attestation, ...payload } = approval;
  const rogueApproval = {
    ...payload,
    attestation: {
      ...attestation,
      signature: crypto.sign(null, Buffer.from(outgoing.stableJson(payload), 'utf8'), rogue.privateKey).toString('base64')
    }
  };

  // Control: the same rogue key verifies when it is the pinned key, so any
  // rejection below is the pin holding rather than the fixture being wrong.
  assert.equal(outgoing.verifyApprovalAttestation(rogueApproval, {
    expectedKeyId: attestation.keyId,
    expectedPublicKeySha256: rogueFingerprint,
    resolvePublicKey: () => roguePem
  }), true);

  const poisons = {
    'Object.getOwnPropertyDescriptors': [Object, 'getOwnPropertyDescriptors', (target) => {
      const real = Object.getOwnPropertyDescriptor(Object, 'getOwnPropertyDescriptors');
      void real;
      return { expectedPublicKeySha256: { value: rogueFingerprint, writable: true, enumerable: true, configurable: true } };
    }],
    'Object.keys': [Object, 'keys', () => []],
    'Reflect.ownKeys': [Reflect, 'ownKeys', () => []],
    'Object.getPrototypeOf': [Object, 'getPrototypeOf', () => Object.prototype],
    'Object.freeze': [Object, 'freeze', (value) => value],
    'Array.isArray': [Array, 'isArray', () => false],
    'Array.prototype.includes': [Array.prototype, 'includes', () => true],
    'Array.prototype.filter': [Array.prototype, 'filter', () => []],
    'Object.prototype.hasOwnProperty': [Object.prototype, 'hasOwnProperty', () => true],
    'JSON.stringify': [JSON, 'stringify', () => '"forged"'],
    'String.prototype.normalize': [String.prototype, 'normalize', function normalize() { return String(this); }]
  };

  for (const [name, [holder, property, replacement]] of Object.entries(poisons)) {
    const original = holder[property];
    let restored = false;
    const restore = () => { if (!restored) { holder[property] = original; restored = true; } };
    try {
      assert.throws(() => outgoing.verifyApprovalAttestation(rogueApproval, {
        ...options,
        resolvePublicKey() {
          holder[property] = replacement;
          return roguePem;
        }
      }), (error) => {
        restore();
        return /pinned fingerprint|signature is invalid|public key/.test(String(error.message));
      }, `poisoning ${name} must not forge verification`);
    } finally {
      restore();
    }
  }

  // The globals must be exactly as they were before the test ran.
  assert.equal(typeof Object.getOwnPropertyDescriptors, 'function');
  assert.equal(Object.keys({ a: 1 }).length, 1);
  assert.equal(Array.isArray([]), true);
});
