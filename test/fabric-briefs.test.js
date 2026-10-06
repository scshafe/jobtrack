'use strict';
// The production briefs (lib/fabric-briefs.js): one per staffed node, store-
// bound, keys scoped per dispatch, no drill vocabulary, the apply node absent.
const assert = require('node:assert/strict');
const test = require('node:test');
const { STAFFED_NODES, briefBodyFor, briefFor, lintFindingsBlock, materialDraftKey } = require('../lib/fabric-briefs');

const ctx = { storeHome: '/tmp/store', jobtrackRoot: '/repo/jobtrack' };

test('every staffed node renders a brief with the item envelope, its commands, the standing rules and the store', () => {
  for (const node of STAFFED_NODES) {
    const item = {
      node, subjectKind: node.startsWith('opportunity') ? 'opportunity' : 'application', subjectId: 7,
      reason: 'because', commands: [`jobtrack something --json`],
      instance: node === 'application.materials.draft' ? 'cover-letter' : undefined,
      act: node.startsWith('email') ? { messageRefId: 42, eventKind: 'interview_invite', source: { fromDomain: 'x.test', accountId: 'a@b.test', messageId: 'm1', threadId: 't1' } } : undefined
    };
    const brief = briefFor(item, ctx, { dispatch: 2 });
    assert.ok(brief, `${node} must brief`);
    assert.match(brief, /^<!--FABRIC-ITEM \{/u);
    assert.match(brief, new RegExp(`# Fabric stage worker: ${node.replace('.', '\\.')}`));
    assert.match(brief, /jobtrack something --json/u);
    assert.match(brief, /## Hard rules \(every worker\)/u);
    assert.match(brief, /Store: JOBTRACK_HOME=\/tmp\/store/u);
    assert.doesNotMatch(brief, /drill store|dealt|loopback|claims file|the site named in your item/iu, `${node} must not carry drill vocabulary`);
    const envelope = JSON.parse(brief.slice('<!--FABRIC-ITEM '.length, brief.indexOf('-->')));
    assert.equal(envelope.dispatch, 2);
    assert.equal(envelope.subjectId, 7);
  }
});

test('the apply node is not staffed by the production dispatcher', () => {
  assert.equal(briefFor({ node: 'application.apply', subjectKind: 'application', subjectId: 1 }, ctx), null);
  assert.equal(briefBodyFor({ node: 'application.apply', subjectId: 1 }, ctx), null);
  assert.equal(briefBodyFor({ node: 'unknown.node', subjectId: 1 }, ctx), null);
  assert.ok(!STAFFED_NODES.includes('application.apply'));
});

test('the shared pure body is the exact production body without an envelope or host rules', () => {
  for (const node of STAFFED_NODES) {
    const item = { node, subjectKind: 'application', subjectId: 12, instance: 'resume' };
    const body = briefBodyFor(item, ctx, { dispatch: 8 });
    assert.ok(body?.trim(), node);
    assert.ok(briefFor(item, ctx, { dispatch: 8 }).includes(body), node);
    assert.doesNotMatch(body, /<!--FABRIC-ITEM|## Hard rules|Store: JOBTRACK_HOME=/u);
  }
});

test('shared drafting retains current editorial findings and chronology-safe retry guidance', () => {
  const body = briefBodyFor({ node: 'application.materials.draft', subjectId: 12, instance: 'resume', act: {
    editorialReviewId: 6,
    editorialFindings: [{ code: 'OWNERSHIP_UNSUPPORTED', message: 'Use the ledger verb', evidence: 'co-designed' }],
    lintFindings: [{ code: 'PAGE_COUNT_EXCEEDS_POLICY', message: 'Two pages' }]
  } }, ctx, { dispatch: 8 });
  assert.match(body, /resume.standard.v4/u);
  assert.match(body, /OWNERSHIP_UNSUPPORTED: Use the ledger verb \[co-designed\]/u);
  assert.match(body, /preserve useful employment chronology/u);
  assert.match(body, /fabric-worker-<kind>-revised-12-d8/u);
  assert.doesNotMatch(body, /cut a role or|2200 characters/u);
});

test('email review requires a successful pinned source read before any ambiguity or handling decision', () => {
  const body = briefBodyFor({ node: 'email.review', subjectId: 12, act: { messageRefId: 3 } }, ctx);
  const readGate = body.indexOf('Before ANY ambiguity judgment');
  const ambiguity = body.indexOf('0. If the queue');
  assert.ok(readGate >= 0 && ambiguity > readGate);
  assert.match(body, /leave this message unresolved; do not mark it handled/u);
  assert.match(body, /After a successful source read, ALWAYS finish/u);
  assert.match(body, /a failed source read must remain unresolved/u);
});

test('shared email workers preserve intent independently, fence send starts and require explicit exact-thread supersession review', () => {
  for (const node of ['email.review', 'email.reply']) {
    const body = briefBodyFor({ node, subjectId: 12, act: { messageRefId: 3 } }, ctx);
    assert.match(body, /jobtrack email reply-intent --message-ref-id 3/u);
    assert.match(body, /jobtrack email reply-intents --application-id 12/u);
    assert.match(body, /jobtrack email reply-send-start --intent-id/u);
    assert.match(body, /Only a NEW send-start \(reused=false\) may continue immediately; a replay must/u);
    assert.match(body, /reconcileOnly/u);
    assert.match(body, /no send authority|not approval or send authority/u);
    assert.ok(body.indexOf('jobtrack email reply-intent --') < body.indexOf('scripts/prepare-reply-draft.cjs'));
    // email.review also documents the separate ambiguous multi-application
    // clarification lane earlier; this barrier governs its ordinary reply.
    assert.ok(body.indexOf('jobtrack email reply-send-start') < body.lastIndexOf('jobtrack email send-approved'));
  }
  const review = briefBodyFor({ node: 'email.review', subjectId: 12, act: { messageRefId: 3 } }, ctx);
  assert.match(review, /Whether this message needed a reply or only a transition/u);
  assert.match(review, /reviewing BOTH exact source messages/u);
  assert.match(review, /--expected-evidence-digest <current digest>/u);
  assert.match(review, /Cross-thread references remain unresolved/u);
  assert.match(review, /No automatic historical intent backfill/u);
  assert.match(review, /Supersession NEVER clears an\s+uncertain-send reconciliation duty/u);
});

test('triage forbids the network, intake and research bound it to public pages, and the rules forbid submitting or approving', () => {
  const triage = briefFor({ node: 'opportunity.triage', subjectKind: 'opportunity', subjectId: 3, reason: 'r' }, ctx);
  assert.match(triage, /No network call is needed or allowed\s+for triage/u);
  assert.match(triage, /jobtrack profile extract --purpose general/u);
  const intake = briefFor({ node: 'application.intake', subjectKind: 'application', subjectId: 3, reason: 'r' }, ctx);
  assert.match(intake, /plain GET \(curl; no login, no form, no\s+script execution\)/u);
  const research = briefFor({ node: 'application.research', subjectKind: 'application', subjectId: 3, reason: 'r' }, ctx);
  assert.match(research, /employer's own\s+domain/u);
  assert.match(research, /never submit an application, never create an\s+account/u);
});

test('drafting keys are scoped by kind, stage and dispatch, and lint findings are put in front of the worker', () => {
  const item = { node: 'application.materials.draft', subjectKind: 'application', subjectId: 9, instance: 'resume', reason: 'revise', act: { lintFindings: [{ code: 'PAGE_COUNT_EXCEEDS_POLICY', message: 'two pages', evidence: 'pages=2' }] } };
  const brief = briefFor(item, ctx, { dispatch: 3 });
  assert.match(brief, /fabric-worker-<kind>-rough-9-d3/u);
  assert.match(brief, /fabric-worker-<kind>-final-9-d3/u);
  assert.match(brief, /Fix these render-lint findings FIRST/u);
  assert.match(brief, /PAGE_COUNT_EXCEEDS_POLICY: two pages \[pages=2\]/u);
  assert.match(brief, /resume.standard.v4/u);
  assert.doesNotMatch(brief, /resume.standard.v3: \{ name, contactLine/u, 'the worker is no longer told to author a header');
  assert.match(brief, /The header is not yours to write/u);
  assert.match(brief, /A project bullet says what the project is and why it matters/u);
  assert.match(brief, /420–470 measured words/u);
  assert.match(brief, /separate reviewer/u);
  assert.match(brief, /`workDetails`/u);
  assert.match(brief, /at most two rendered lines/u);
  assert.match(brief, /never ends in a one-word line/u);
  assert.match(brief, /BULLET_RENDERS_THREE_LINES, BULLET_WIDOW_LINE/u);
  assert.match(brief, /source's own ownership verb/u);
  assert.match(brief, /Keep comparative goals comparative/u);
  assert.doesNotMatch(brief, /Address these independent editorial findings/u, 'no editorial block without editorial findings');
  const editorial = briefFor({ ...item, act: { editorialReviewId: 4, editorialFindings: [{ code: 'EDITORIAL_CHANGES_REQUESTED', message: '1. Restore the PostgreSQL model bullet.' }] } }, ctx, { dispatch: 4 });
  assert.match(editorial, /Address these independent editorial findings FIRST \(review 4 requested changes\)/u);
  assert.match(editorial, /EDITORIAL_CHANGES_REQUESTED: 1\. Restore the PostgreSQL model bullet\./u);
  assert.match(editorial, /chain a `revised` revision on it/u);
  assert.match(brief, /Never turn bounded facts into habits or sequences/u);
  assert.doesNotMatch(brief, /2200 characters|resume.standard.v2/u);
  assert.equal(materialDraftKey('resume', 'final', item, { dispatch: 3 }), 'fabric-worker-resume-final-9-d3');
  assert.equal(lintFindingsBlock({ act: {} }), '');
});

test('email briefs carry the message coordinates and the repo path of the outgoing recipe', () => {
  const act = { messageRefId: 11, eventKind: 'interview_invite', source: { fromDomain: 'mydrove.com', accountId: 'me@example.test', messageId: 'mid', threadId: 'tid' }, candidates: [{ applicationId: 4 }, { applicationId: 5 }] };
  const review = briefFor({ node: 'email.review', subjectKind: 'application', subjectId: 4, reason: 'r', act }, ctx);
  assert.match(review, /--candidates 4,5/u);
  assert.match(review, /node \/repo\/jobtrack\/scripts\/prepare-reply-draft\.cjs/u);
  assert.match(review, /prepare-clarification-draft\.cjs/u);
  assert.match(review, /node \/repo\/jobtrack\/scripts\/read-email-source\.cjs --source source\.json --json/u);
  assert.match(review, /retaining all supplied fields/u);
  assert.match(review, /source read is an unresolved transport error, NOT a decision of "none"/u);
  assert.match(review, /without resolving, transitioning or marking\s+the message handled/u);
  assert.match(review, /Do not substitute a PATH-installed mail tool/u);
  assert.doesNotMatch(review, /gog gmail/u);
  assert.doesNotMatch(review, /synthesize-welcome-draft\.cjs/u);
  assert.match(review, /fabric-email-handled-11-a4/u);
  const reply = briefFor({ node: 'email.reply', subjectKind: 'application', subjectId: 4, reason: 'r', act: { ...act, decision: 'reply', attempts: 1, lastAttemptAt: 'x', subjectEvidence: 'Re: Next steps' } }, ctx, { dispatch: 1 });
  assert.match(reply, /fabric-email-reply-attempt-11-a1-d1/u);
  assert.match(reply, /"Re: Next steps"/u);
  assert.match(reply, /node \/repo\/jobtrack\/scripts\/read-email-source\.cjs --source source\.json --json/u);
  assert.match(reply, /node \/repo\/jobtrack\/scripts\/prepare-reply-draft\.cjs --source source\.json/u);
  assert.match(reply, /source read must stop this attempt; do not draft, approve or send from facts/u);
  assert.match(reply, /Do not substitute a PATH-installed mail tool/u);
  assert.doesNotMatch(reply, /gog gmail|synthesize-welcome-draft\.cjs/u);
});
