'use strict';

// A data-only, standalone sealer for externally authored composition. It does
// NOT run a model or claim that it wrote the supplied prose. The provenance
// names that distinction, and seals the exact supplied bytes and policy.
const { digestCanonicalJson } = require('../lib/email-outgoing-v2-contracts');
const { validateDraftRequest } = require('../lib/draft-runner/contracts');
const {
  createVerifyRequestStage, createClassifyEventStage, createSelectEvidenceStage,
  createSealProposalStage
} = require('../lib/draft-runner/stages');

async function sealComposition(input, clock = () => new Date().toISOString()) {
  const { request, manifest, composition } = input;
  validateDraftRequest(request);
  if (manifest?.operation !== 'seal_external_composition'
      || manifest.compositionDigest !== digestCanonicalJson(composition)
      || digestCanonicalJson(manifest) !== request.manifestDigest
      || manifest.toneDigest !== request.toneDecisionDigest
      || manifest.voiceDigest !== request.voiceRevisionDigest) {
    throw new Error('COMPOSITION_PROVENANCE_MISMATCH');
  }
  if (!['model', 'template'].includes(composition.authorship)) throw new Error('AUTHORSHIP_UNSUPPORTED');
  const startedAt = clock();
  const policy = await createVerifyRequestStage({ now: clock }).run(request);
  const intent = await createClassifyEventStage().run(policy);
  const evidence = await createSelectEvidenceStage().run({ policy, intent });
  const sealed = await createSealProposalStage({
    now: clock, proposalIdFor: () => input.proposalId, contentIdFor: () => input.contentId
  }).run({ policy, intent, evidence, composition });
  const completedAt = clock();
  return {
    result: {
      schemaVersion: 'jobtrack-email-reply-draft-result.v1',
      resultId: `${request.requestId}:result`, requestId: request.requestId,
      requestDigest: digestCanonicalJson(request), proposal: sealed.proposal,
      approvedContent: sealed.approvedContent,
      usage: { runner: 'standalone_out_of_process', toolCalls: 0, toolsUsed: [], sideEffects: [] },
      completedAt, idempotencyKey: `${request.requestId}:record`
    },
    provenance: {
      schemaVersion: 'jobtrack-external-composition-seal.v1',
      operation: 'seal_external_composition', authoring: 'caller_supplied_not_independently_attested',
      compositionDigest: digestCanonicalJson(composition), manifestDigest: request.manifestDigest,
      requestDigest: digestCanonicalJson(request), modelInvocations: 0,
      startedAt, completedAt, safety: sealed.safety
    }
  };
}

if (require.main === module) {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    text += chunk;
    if (Buffer.byteLength(text) > 1_048_576) {
      process.stderr.write('SEAL_INPUT_TOO_LARGE\n'); process.exit(2);
    }
  });
  process.stdin.on('end', async () => {
    try { process.stdout.write(`${JSON.stringify(await sealComposition(JSON.parse(text)))}\n`); }
    catch (error) { process.stderr.write(`${error.code || 'SEAL_REFUSED'}: ${error.message}\n`); process.exitCode = 2; }
  });
}
module.exports = { sealComposition };
