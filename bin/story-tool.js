#!/usr/bin/env node
'use strict';

// story-tool — the friendly front door for putting Cole's stories into the
// JobTrack corpus.
//
// WHY THIS EXISTS. The underlying `jobtrack story` lane is deliberately
// strict: every mutation carries an --expected-version (optimistic locking)
// and an --idempotency-key, and a usable story takes four separate commands
// (capture -> polish -> facet claim -> permission set) in the right order
// with the version bumping after each. That strictness is correct for a
// durable, audited corpus — and miserable to drive by hand, which is how
// stories end up half-entered.
//
// This tool drives that exact public CLI (never the internals, so it cannot
// drift silently) and takes care of the ceremony: it reads the current
// version between steps, derives idempotency keys from the CONTENT so
// re-running the same add is a safe replay rather than a duplicate, and
// prints every underlying command it ran so the audit trail is legible and
// the next person learns the real interface.
//
// Start with:  story-tool guide

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { assertNoPrivateJournalSource } = require('../lib/private-source-boundary');

const JOBTRACK_CLI = path.join(__dirname, 'jobtrack.js');

// The controlled facet vocabulary: the contract between a story's claims and
// the behavioral questions real applications ask. Generated from applysim's
// question corpus (flows/question-sets/, pinned by
// lib/__tests__/question-corpus.test.mjs). A facet nothing claims is a
// question nobody can answer — so this list doubles as the authoring backlog.
const FACET_VOCABULARY = Object.freeze([
  ['abandoned-effort', 'What did you try and ultimately abandon, and why?'],
  ['ai-built', 'Describe something you built, automated, or changed using AI.'],
  ['ai-human-boundary', 'Which tasks do you believe should remain primarily human, and why?'],
  ['ai-judgment-maintenance', 'How do you maintain your own judgment and skill while using AI extensively?'],
  ['ai-verification', 'How do you verify information or work produced with AI?'],
  ['assumption-revised', 'What professional assumption have you revised in the last year?'],
  ['assumptions-unwanted', 'What assumptions about you would you prefer we not make?'],
  ['async-communication', 'What does excellent asynchronous communication look like?'],
  ['bias-challenged', 'Tell us about a time you challenged your own bias or assumption.'],
  ['business-impact', 'What is the clearest example of your work improving a business, team, cus'],
  ['candid-weakness', 'What would a candid former colleague say can be difficult about working w'],
  ['career-narrative', 'What is something important about your career story that is easy to miss '],
  ['changed-my-mind', 'When have you changed your position during a disagreement?'],
  ['coaching-judgment', 'How do you decide when to coach, when to direct, and when to step back?'],
  ['communication', 'Tell us about a time careful listening revealed the real problem.'],
  ['constraint-driven-design', 'Describe a time a constraint improved your solution.'],
  ['courage-hidden', 'What have you done that required more courage than it appeared to from th'],
  ['customer-needs-discovery', 'How do you uncover what a customer actually needs rather than only what t'],
  ['dealbreakers', 'What would make you leave a new job within the first few months?'],
  ['deciding-what-not-to-do', 'How do you decide what not to do?'],
  ['failure-owned', 'Tell us about a time you let someone down.'],
  ['feedback-receptiveness', 'Describe a time you initially disagreed with feedback but later found it '],
  ['generosity-lesson', 'What experience has made you more generous in how you interpret other peo'],
  ['good-decision-bad-outcome', 'What is an example of a decision you are proud of even though the outcome'],
  ['hard-tradeoff-decision', 'Describe a decision in which every available option had meaningful drawba'],
  ['impact-on-others', 'What is something you know to be true about how others experience you?'],
  ['integrity-cost', 'Describe a time doing the right thing carried a personal or professional '],
  ['intellectual-honesty', 'Tell us about a time you sought expertise instead of pretending to have i'],
  ['intrinsic-motivation', 'What has been the most intrinsically rewarding work you have done?'],
  ['judgment', 'Describe a decision in which every available option had meaningful drawba'],
  ['leading-without-authority', 'Tell us about a time you led without having formal authority.'],
  ['letting-someone-down', 'Tell us about a time you let someone down.'],
  ['listening-diagnosis', 'Tell us about a time careful listening revealed the real problem.'],
  ['natural-strengths', 'What kind of work seems to come more naturally to you than to most peopl'],
  ['no-playbook', 'Tell us about a time you succeeded without a clear playbook.'],
  ['ownership', 'Tell us about a time you took ownership of a problem no one had assigned'],
  ['personal-quirk', 'What is a habit you have that your friends would make fun of? Be specific'],
  ['pride-off-resume', 'What is something you are proud of that would never belong on a resume?'],
  ['prioritization', 'How do you decide what not to do?'],
  ['problem-solving', 'Tell us about a problem you solved by reframing the question.'],
  ['productive-disagreement', 'Tell us about a disagreement that ultimately improved the work.'],
  ['reframing-problem', 'Tell us about a problem you solved by reframing the question.'],
  ['resilience', 'Tell us about a time resilience meant changing course rather than simply '],
  ['seeking-expertise', 'Tell us about a time you sought expertise instead of pretending to have i'],
  ['self-awareness', 'What is something you know to be true about how others experience you?'],
  ['self-scrutiny', 'How do you challenge your own conclusions before presenting them?'],
  ['speaking-up', 'Tell us about a time you spoke up when remaining silent would have been e'],
  ['startup-motivation', 'What attracts you to an early-stage or high-growth environment?'],
  ['strategic-pivot', 'Tell us about a time resilience meant changing course rather than simply '],
  ['strength-overuse', 'Which of your strengths can become a liability when overused?'],
  ['support-with-accountability', 'How do you balance support with accountability?'],
  ['taken-seriously', 'What is something you take surprisingly seriously?'],
  ['teamwork', 'Describe an experience that challenged your ability to work effectively i'],
  ['teamwork-difficulty', 'Describe an experience that challenged your ability to work effectively i'],
  ['unconventional-path', 'Tell us about a career move that looked unconventional but made sense to '],
]);

const PURPOSES = ['general', 'cover_letter', 'resume', 'application_form', 'interview', 'networking', 'public_bio'];
const DEFAULT_ALLOW = ['application_form', 'interview'];

// ---------------------------------------------------------------------------
// Driving the real CLI
// ---------------------------------------------------------------------------

let VERBOSE = false;

function runJobtrack(args, { quiet = false } = {}) {
  const printable = ['jobtrack', ...args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a))].join(' ');
  if (VERBOSE && !quiet) console.log(`  $ ${printable}`);
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [JOBTRACK_CLI, ...args, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024
    });
  } catch (error) {
    const raw = `${error.stdout || ''}${error.stderr || ''}`.trim();
    let message = raw;
    try {
      const parsed = JSON.parse(error.stdout || '{}');
      if (parsed?.error?.message) message = parsed.error.message;
    } catch { /* keep raw */ }
    throw new Error(`jobtrack ${args[0]} ${args[1] || ''} failed: ${message}`);
  }
  return JSON.parse(stdout);
}

/** A content-derived key: re-running the same step is a replay, not a double-write. */
function keyFor(...parts) {
  return `story-tool-${crypto.createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdGuide() {
  console.log(`
STORY AUTHORING GUIDE
=====================

WHAT A STORY IS HERE
  A story is one real experience, told ON ITS OWN TERMS — not shaped as an
  answer to any particular interview question. That is the whole point: the
  same experience gets tailored to many different questions later, and a
  narrative captured in the shape of one question loses what the next
  question needs.

  Write the FULL story. Length is fine. Application answers get compressed
  from it at submission time; nothing is compressed at authoring time.

THE THREE THINGS EVERY STORY NEEDS
  1. The narrative      what happened, in your words
  2. A takeaway         what you concluded, in one line
  3. Facet claims       what this story DEMONSTRATES, as retrieval keys

  Facets are how a story gets found. An application asks "tell me about a
  time you led without authority"; the matcher looks for a story CLAIMING
  'leading-without-authority'. Prose overlap alone never matches — a claim
  is required. See:  story-tool facets

THE ONE COMMAND YOU MOSTLY NEED
  story-tool add \\
    --title "The ROCm weekend" \\
    --file story.md \\
    --takeaway "Ramp fast by building the smallest end-to-end proof" \\
    --facet 'rapid-learning=Ramped an unfamiliar GPU stack to productive in one weekend' \\
    --facet 'no-playbook=No documentation existed for the toolchain I needed'

  That runs capture -> polish -> facet claims -> permissions as one
  transaction-ish sequence, handling version numbers and idempotency keys
  for you. Re-running the identical command is a safe replay, not a
  duplicate.

HONESTY RULES (these are load-bearing)
  * Only YOU author stories. An agent may transcribe, ask clarifying
    questions, and tidy prose — it must never invent an experience, a
    detail, or a quantified result you did not state.
  * A claim must be true of the story as written. If the narrative does not
    actually show 'leading-without-authority', do not claim it — a false
    claim surfaces a story for a question it cannot honestly answer.
  * Sensitive material: use --sensitivity private|sensitive|highly_sensitive
    and grant purposes narrowly. Default permissions are
    ${DEFAULT_ALLOW.join(' + ')}.

TYPICAL SESSION
  story-tool facets --unclaimed     # what is still unanswerable
  story-tool add ...                # write one story
  story-tool list                   # confirm it landed
  story-tool coverage --questions gate.json   # how many questions now map

WHERE THINGS LIVE
  Corpus:  \$JOBTRACK_HOME (default ~/.jobtrack), table profile_stories
  Vocab:   the ${FACET_VOCABULARY.length} facets the question corpus asks for
  Raw CLI: jobtrack story --help   (this tool is a wrapper over it)
`.trim());
}

function cmdFacets(flags) {
  const claimed = new Map();
  try {
    const rows = runJobtrack(['story', 'list', '--limit', '100'], { quiet: true });
    for (const story of rows.stories ?? []) {
      const detail = runJobtrack(['story', 'show', String(story.id)], { quiet: true });
      for (const facet of detail.story?.facets ?? []) {
        if (!claimed.has(facet.facet)) claimed.set(facet.facet, []);
        claimed.get(facet.facet).push(`#${story.id} ${detail.story.title}`);
      }
    }
  } catch (error) {
    console.error(`(could not read the corpus: ${error.message})`);
  }

  const unclaimedOnly = Boolean(flags.unclaimed);
  const rows = FACET_VOCABULARY.filter(([facet]) => !unclaimedOnly || !claimed.has(facet));
  console.log(unclaimedOnly
    ? `UNCLAIMED FACETS — ${rows.length} of ${FACET_VOCABULARY.length} still have no story\n`
    : `FACET VOCABULARY — ${FACET_VOCABULARY.length} facets, ${claimed.size} claimed\n`);
  for (const [facet, example] of rows) {
    const owners = claimed.get(facet);
    const mark = owners ? '[x]' : '[ ]';
    console.log(`${mark} ${facet}`);
    console.log(`      asked as: "${example}${example.length >= 70 ? '…' : ''}"`);
    if (owners) console.log(`      claimed by: ${owners.join('; ')}`);
  }
  if (!unclaimedOnly) {
    console.log(`\nOne story usually claims 3-6 facets, so ~15-20 good stories can cover this list.`);
    console.log(`Next: story-tool facets --unclaimed`);
  }
}

function readText(flags, label) {
  if (flags.file) {
    const file = flags.file === '-' ? 0 : flags.file;
    return fs.readFileSync(file, 'utf8');
  }
  if (flags.text !== undefined) return String(flags.text);
  throw new Error(`${label}: provide --file PATH (or --file - for stdin) or --text "..."`);
}

function parseFacetArgs(values) {
  const facets = [];
  for (const raw of values) {
    const at = String(raw).indexOf('=');
    if (at <= 0) throw new Error(`--facet must look like 'slug=what this story demonstrates', got: ${raw}`);
    const facet = raw.slice(0, at).trim();
    const claim = raw.slice(at + 1).trim();
    if (!/^[a-z][a-z0-9_-]{1,47}$/.test(facet)) throw new Error(`'${facet}' is not a valid facet slug (lower-kebab)`);
    if (!claim) throw new Error(`facet '${facet}' needs a claim after the '='`);
    facets.push({ facet, claim });
  }
  return facets;
}

function cmdAdd(flags) {
  const title = flags.title;
  if (!title) throw new Error('--title is required');
  // Fail before reading a byte. The private journal is not a JobTrack source,
  // even when a caller points this convenience wrapper directly at a file.
  assertNoPrivateJournalSource({
    file: flags.file,
    canonicalFile: flags.canonicalFile,
    source: flags.source
  });
  const narrative = readText(flags, 'the story');
  if (narrative.trim().length < 40) {
    throw new Error('the story text looks too short to be a real narrative — write the full story, not a summary');
  }
  const facets = parseFacetArgs([].concat(flags.facet ?? []));
  if (facets.length === 0) {
    throw new Error(
      'at least one --facet is required: a story nothing claims can never be found.\n'
      + "  format: --facet 'slug=what this story demonstrates'\n"
      + '  see:    story-tool facets --unclaimed'
    );
  }
  const unknown = facets.filter(({ facet }) => !FACET_VOCABULARY.some(([known]) => known === facet));
  if (unknown.length && !flags.allowNewFacets) {
    throw new Error(
      `these facets are not in the question corpus's vocabulary: ${unknown.map((f) => f.facet).join(', ')}\n`
      + '  A facet no question asks for will never be matched. Either pick from\n'
      + '  `story-tool facets`, or pass --allow-new-facets if you are deliberately\n'
      + '  adding vocabulary ahead of the questions.'
    );
  }

  const allow = flags.allow === undefined
    ? DEFAULT_ALLOW
    : String(flags.allow).split(',').map((p) => p.trim()).filter(Boolean);
  for (const purpose of allow) {
    if (!PURPOSES.includes(purpose)) throw new Error(`unknown purpose '${purpose}' (choose from ${PURPOSES.join(', ')})`);
  }

  const contentKey = crypto.createHash('sha256').update(`${title} ${narrative}`).digest('hex').slice(0, 16);
  const source = flags.source ?? `Cole authoring session ${new Date().toISOString().slice(0, 10)}`;
  const tmp = path.join(require('node:os').tmpdir(), `story-tool-${contentKey}.txt`);
  fs.writeFileSync(tmp, narrative, { mode: 0o600 });

  try {
    console.log(`Adding "${title}"…`);

    // 1. CAPTURE — the raw narrative, preserved byte for byte.
    let result = runJobtrack([
      'story', 'capture',
      '--title', title,
      '--raw-file', tmp,
      '--source', source,
      '--capture-kind', 'note',
      '--confidence', 'high',
      '--sensitivity', flags.sensitivity ?? 'private',
      ...(flags.tags ? ['--tags', flags.tags] : []),
      '--idempotency-key', keyFor('capture', contentKey)
    ]);
    const storyId = result.story.id;
    let version = result.story.lock_version;
    console.log(`  captured  story #${storyId}`);

    // 2. POLISH — the canonical revision. Same text unless a separate
    //    --canonical-file is given, because the story as told IS the story.
    const canonicalFile = flags.canonicalFile ?? tmp;
    result = runJobtrack([
      'story', 'polish',
      '--story-id', String(storyId),
      '--expected-version', String(version),
      '--canonical-file', canonicalFile,
      ...(flags.summary ? ['--summary', flags.summary] : []),
      ...(flags.takeaway ? ['--takeaway', flags.takeaway] : []),
      ...(flags.whyItMatters ? ['--why-it-matters', flags.whyItMatters] : []),
      ...(flags.structure ? ['--structure', flags.structure] : []),
      '--status', flags.status ?? 'ready',
      '--authored-by', flags.authoredBy ?? 'Cole',
      '--idempotency-key', keyFor('polish', contentKey)
    ]);
    version = result.story.lock_version;
    console.log(`  polished  status=${result.story.status}`);

    // 3. FACET CLAIMS — what the story demonstrates; this is what makes it
    //    findable by a question phrased in words the prose never uses.
    for (const { facet, claim } of facets) {
      result = runJobtrack([
        'story', 'facet', 'claim',
        '--story-id', String(storyId),
        '--expected-version', String(version),
        '--facet', facet,
        '--claim', claim,
        ...(flags.weight ? ['--weight', String(flags.weight)] : []),
        '--idempotency-key', keyFor('facet', contentKey, facet)
      ]);
      version = result.story.lock_version;
      console.log(`  claimed   ${facet}`);
    }

    // 4. PERMISSIONS — a story with none is captured but unusable.
    for (const purpose of allow) {
      result = runJobtrack([
        'story', 'permission', 'set',
        '--story-id', String(storyId),
        '--expected-version', String(version),
        '--purpose', purpose,
        '--decision', 'allow',
        '--approved-by', flags.approvedBy ?? 'Cole',
        '--idempotency-key', keyFor('permission', contentKey, purpose)
      ]);
      version = result.story.lock_version;
      console.log(`  allowed   ${purpose}`);
    }

    console.log(`\nStory #${storyId} is in the corpus and ready to be matched.`);
    if (allow.length === 0) {
      console.log('NOTE: no purposes granted, so nothing can use it yet. Run:');
      console.log(`  story-tool allow ${storyId} --purpose application_form`);
    }
    const stillUnclaimed = FACET_VOCABULARY.filter(([f]) => !facets.some((x) => x.facet === f)).length;
    console.log(`Next: story-tool facets --unclaimed   (${stillUnclaimed} facets still unanswered)`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function cmdList() {
  const rows = runJobtrack(['story', 'list', '--limit', '100'], { quiet: true });
  const stories = rows.stories ?? [];
  if (stories.length === 0) {
    console.log('The corpus has no stories yet.\nStart with:  story-tool guide');
    return;
  }
  console.log(`${stories.length} stor${stories.length === 1 ? 'y' : 'ies'} in the corpus\n`);
  for (const story of stories) {
    const detail = runJobtrack(['story', 'show', String(story.id)], { quiet: true }).story;
    const facets = (detail.facets ?? []).map((f) => f.facet).join(', ') || '(no facets — unfindable)';
    const purposes = (detail.permissions ?? []).filter((p) => p.decision === 'allow').map((p) => p.purpose).join(', ') || '(no purposes granted)';
    console.log(`#${story.id}  ${detail.title}`);
    console.log(`     status: ${detail.status}   sensitivity: ${detail.sensitivity}`);
    console.log(`     facets: ${facets}`);
    console.log(`     usable for: ${purposes}`);
  }
}

function cmdShow(args) {
  const id = args[0];
  if (!id) throw new Error('usage: story-tool show <story-id> [--raw]');
  const detail = runJobtrack(['story', 'show', String(id), ...(process.argv.includes('--raw') ? ['--include-raw'] : [])], { quiet: true }).story;
  console.log(`#${detail.id}  ${detail.title}`);
  console.log(`status ${detail.status} · sensitivity ${detail.sensitivity} · version ${detail.lock_version}\n`);
  if (detail.currentRevision) {
    console.log(detail.currentRevision.canonical_text);
    if (detail.currentRevision.takeaway) console.log(`\nTakeaway: ${detail.currentRevision.takeaway}`);
  }
  console.log('\nFacet claims:');
  for (const facet of detail.facets ?? []) console.log(`  ${facet.facet} (weight ${facet.weight}) — ${facet.claim}`);
  console.log('\nPermissions:');
  for (const permission of detail.permissions ?? []) console.log(`  ${permission.purpose}: ${permission.decision}`);
}

function cmdClaim(args, flags) {
  const id = args[0];
  if (!id) throw new Error("usage: story-tool claim <story-id> --facet 'slug=claim text'");
  const facets = parseFacetArgs([].concat(flags.facet ?? []));
  if (!facets.length) throw new Error("--facet 'slug=claim text' is required");
  let version = runJobtrack(['story', 'show', String(id)], { quiet: true }).story.lock_version;
  for (const { facet, claim } of facets) {
    const result = runJobtrack([
      'story', 'facet', 'claim',
      '--story-id', String(id), '--expected-version', String(version),
      '--facet', facet, '--claim', claim,
      ...(flags.replace ? ['--replace'] : []),
      ...(flags.weight ? ['--weight', String(flags.weight)] : []),
      '--idempotency-key', keyFor('claim', String(id), facet, claim)
    ]);
    version = result.story.lock_version;
    console.log(`claimed ${facet} on story #${id}`);
  }
}

function cmdAllow(args, flags) {
  const id = args[0];
  const purpose = flags.purpose;
  if (!id || !purpose) throw new Error('usage: story-tool allow <story-id> --purpose application_form');
  if (!PURPOSES.includes(purpose)) throw new Error(`unknown purpose '${purpose}' (choose from ${PURPOSES.join(', ')})`);
  const version = runJobtrack(['story', 'show', String(id)], { quiet: true }).story.lock_version;
  runJobtrack([
    'story', 'permission', 'set',
    '--story-id', String(id), '--expected-version', String(version),
    '--purpose', purpose, '--decision', flags.decision ?? 'allow',
    '--approved-by', flags.approvedBy ?? 'Cole',
    '--idempotency-key', keyFor('allow', String(id), purpose, flags.decision ?? 'allow')
  ]);
  console.log(`story #${id}: ${purpose} = ${flags.decision ?? 'allow'}`);
}

function cmdCoverage(flags) {
  if (!flags.questions) {
    throw new Error(
      'usage: story-tool coverage --questions <file>\n'
      + '  Generate the questions file from applysim:\n'
      + '    node scripts/export-gate-questions.mjs drove-behavioral-screen > gate.json'
    );
  }
  const runKey = `coverage-${Date.now()}`;
  const result = runJobtrack(['story', 'gate', '--questions-file', flags.questions, '--run-key', runKey], { quiet: true });
  const v = result.verdict;
  console.log('CORPUS COVERAGE\n');
  console.log(`  required questions:   ${v.requiredTotal}`);
  console.log(`  answerable now:       ${v.requiredMapped}`);
  console.log(`  awaiting permission:  ${v.requiredNeedsApproval}`);
  console.log(`  BLOCKED (no story):   ${v.requiredBlocked}`);
  console.log(`  optional blocked:     ${v.optionalBlocked}`);
  const blocked = result.questions.filter((q) => q.decision === 'blocked' && q.required);
  if (blocked.length) {
    console.log('\nQuestions with no story behind them:');
    for (const q of blocked.slice(0, 20)) {
      console.log(`  - ${q.prompt}`);
      console.log(`      wants: ${q.facets.join(', ')}`);
    }
    if (blocked.length > 20) console.log(`  … and ${blocked.length - 20} more`);
  }
  console.log(`\n${v.submitEligible ? 'Every required question maps to a story.' : 'Not yet submittable — write stories for the facets above.'}`);
}

function usage() {
  console.log(`
story-tool — add Cole's stories to the JobTrack corpus

USAGE
  story-tool <command> [options]

COMMANDS
  guide                   how to write a story here — READ THIS FIRST
  facets [--unclaimed]    the facet vocabulary and which stories claim it
  add                     add a complete story (the main command)
  list                    what is in the corpus
  show <id> [--raw]       one story in full
  claim <id> --facet …    add a facet claim to an existing story
  allow <id> --purpose …  grant a purpose (application_form, interview, …)
  coverage --questions F  how many real questions the corpus can answer

ADD OPTIONS
  --title TEXT            required
  --file PATH | --text …  the full narrative ('--file -' reads stdin)
  --facet 'slug=claim'    repeatable, at least one required
  --takeaway TEXT         the one-line lesson
  --why-it-matters TEXT   why an employer should care
  --summary TEXT          one-line summary
  --sensitivity LEVEL     normal|private|sensitive|highly_sensitive (default private)
  --allow LIST            purposes to grant (default ${DEFAULT_ALLOW.join(',')}; '' for none)
  --tags CSV              free-form tags
  --status STATUS         captured|developing|ready (default ready)
  --allow-new-facets      permit facets outside the question corpus vocabulary
  --verbose               print every underlying jobtrack command

EXAMPLE
  story-tool add \\
    --title "The ROCm weekend" \\
    --file story.md \\
    --takeaway "Ramp fast by building the smallest end-to-end proof" \\
    --facet 'rapid-learning=Ramped an unfamiliar GPU stack to productive in a weekend'

Every command accepts --help. The store is \$JOBTRACK_HOME (default ~/.jobtrack).
`.trim());
}

// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { args.push(token); continue; }
    const name = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    const isBoolean = ['unclaimed', 'raw', 'replace', 'verbose', 'help', 'allowNewFacets'].includes(name);
    if (isBoolean || next === undefined || next.startsWith('--')) { flags[name] = true; continue; }
    if (flags[name] === undefined) flags[name] = next;
    else flags[name] = [].concat(flags[name], next);
    i += 1;
  }
  return { args, flags };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { args, flags } = parseArgv(rest);
  VERBOSE = Boolean(flags.verbose);

  if (!command || command === 'help' || command === '--help' || flags.help && !command) return usage();
  if (flags.help) {
    // Per-command help routes back through the guide/usage, which carry the
    // real detail; a second copy would only drift.
    if (command === 'add') return usage();
    if (command === 'guide' || command === 'facets') return cmdGuide();
    return usage();
  }

  switch (command) {
    case 'guide': return cmdGuide();
    case 'facets': return cmdFacets(flags);
    case 'add': return cmdAdd(flags);
    case 'list': return cmdList();
    case 'show': return cmdShow(args);
    case 'claim': return cmdClaim(args, flags);
    case 'allow': return cmdAllow(args, flags);
    case 'coverage': return cmdCoverage(flags);
    default:
      console.error(`Unknown command: ${command}\n`);
      usage();
      process.exit(2);
  }
}

try {
  main();
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}
