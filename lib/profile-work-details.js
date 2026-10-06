'use strict';

// profile-work-details.js — arbitrarily nested detail OUTLINES for work
// experience (Cole's directive, 2026-08-05).
//
// Highlights set the tone; the outline captures the work COMPREHENSIVELY — a
// bullet tree as deep as the operator wants, addressable per node, so a
// generation can later pull the exact specifics that answer a posting's
// requirements instead of re-summarizing from memory.
//
// Storage is an adjacency list (profile_work_entry_details): every node has an
// id, so future material contexts can cite outline nodes as evidence the same
// way they cite profile entries today. Positions are dense per sibling group.

class WorkDetailError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkDetailError';
    this.code = code;
  }
}

const MAX_DETAIL_TEXT = 4000;
const MAX_OUTLINE_NODES = 2000;
const MAX_DEPTH = 12;

// Fact-ledger vocabulary (RESUME_QUALITY_PLAN.md §4). A node that carries any
// typed fact must also carry authorship: only human-authored nodes will be
// citable as bullet evidence, and recording WHO wrote a fact at write time is
// what keeps provenance from laundering invention (plan L4).
const DETAIL_KINDS = Object.freeze(['context', 'action', 'decision', 'outcome', 'scale', 'constraint']);
const MY_ROLES = Object.freeze(['led', 'owned', 'designed', 'co-designed', 'implemented', 'contributed']);
const AUTHORSHIP_KINDS = Object.freeze(['human', 'agent', 'imported']);

function requireWorkEntry(db, workEntryId) {
  const row = db.prepare('SELECT id, role_title, company, highlights FROM profile_work_entries WHERE id=?').get(workEntryId);
  if (!row) throw new WorkDetailError('NOT_FOUND', `Work entry ${workEntryId} not found`);
  return row;
}

function optionalEnum(value, allowed, label) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw new WorkDetailError('INVALID_ARGUMENT', `${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function optionalBoundedText(value, label, max = 2000) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw new WorkDetailError('INVALID_ARGUMENT', `${label} exceeds ${max} characters`);
  return text;
}

/** Validate the typed-fact fields as a set. Any fact field requires a kind,
 * and a kind requires explicit authorship — a fact without an author is not
 * a fact this ledger can ever cite. */
function normalizeFactFields(input) {
  const fact = {
    kind: optionalEnum(input.kind, DETAIL_KINDS, 'kind'),
    baseline: optionalBoundedText(input.baseline, 'baseline'),
    result: optionalBoundedText(input.result, 'result'),
    myRole: optionalEnum(input.myRole, MY_ROLES, 'my-role'),
    confidential: input.confidential === true || input.confidential === 'true' || input.confidential === '1' || input.confidential === 1,
    evidenceUrl: optionalBoundedText(input.evidenceUrl, 'evidence-url'),
    authorshipKind: optionalEnum(input.authorshipKind, AUTHORSHIP_KINDS, 'authorship-kind'),
    authoredBy: optionalBoundedText(input.authoredBy, 'authored-by', 200)
  };
  const carriesFact = Boolean(fact.baseline || fact.result || fact.myRole || fact.evidenceUrl);
  if (carriesFact && !fact.kind) {
    throw new WorkDetailError('FACT_KIND_REQUIRED', 'A baseline, result, my-role, or evidence-url needs an explicit --kind');
  }
  if (fact.kind && !fact.authorshipKind) {
    throw new WorkDetailError('FACT_AUTHORSHIP_REQUIRED', 'Typed fact nodes need --authorship-kind (human|agent|imported) — only human-authored facts are citable');
  }
  if (fact.authorshipKind && !fact.authoredBy) {
    throw new WorkDetailError('FACT_AUTHORSHIP_REQUIRED', '--authorship-kind needs --authored-by naming the author');
  }
  return fact;
}

function requireDetail(db, detailId) {
  const row = db.prepare('SELECT * FROM profile_work_entry_details WHERE id=?').get(detailId);
  if (!row) throw new WorkDetailError('NOT_FOUND', `Work detail ${detailId} not found`);
  return row;
}

function nextPosition(db, workEntryId, parentDetailId) {
  const row = db.prepare(`
    SELECT COALESCE(MAX(position), 0) + 1 AS position FROM profile_work_entry_details
    WHERE work_entry_id=? AND parent_detail_id IS ?
  `).get(workEntryId, parentDetailId ?? null);
  return row.position;
}

function depthOf(db, detailId) {
  let depth = 0;
  let current = detailId;
  while (current !== null && depth <= MAX_DEPTH) {
    const row = db.prepare('SELECT parent_detail_id FROM profile_work_entry_details WHERE id=?').get(current);
    current = row ? row.parent_detail_id : null;
    depth += 1;
  }
  return depth;
}

/** Add one detail node, optionally carrying typed-fact fields. */
function addWorkDetail(db, { workEntryId, parentDetailId = null, detail, ...factInput }) {
  const entry = requireWorkEntry(db, workEntryId);
  const text = String(detail ?? '').trim();
  if (!text) throw new WorkDetailError('INVALID_ARGUMENT', 'Detail text is required');
  if (text.length > MAX_DETAIL_TEXT) throw new WorkDetailError('INVALID_ARGUMENT', `Detail exceeds ${MAX_DETAIL_TEXT} characters`);
  const fact = normalizeFactFields(factInput);
  if (parentDetailId !== null) {
    const parent = requireDetail(db, parentDetailId);
    if (parent.work_entry_id !== entry.id) {
      throw new WorkDetailError('SCOPE_MISMATCH', `Parent detail ${parentDetailId} belongs to work entry ${parent.work_entry_id}, not ${entry.id}`);
    }
    if (depthOf(db, parentDetailId) >= MAX_DEPTH) {
      throw new WorkDetailError('INVALID_ARGUMENT', `Outline depth exceeds ${MAX_DEPTH}`);
    }
  }
  const info = db.prepare(`
    INSERT INTO profile_work_entry_details(
      work_entry_id, parent_detail_id, position, detail,
      kind, baseline, result, my_role, confidential, evidence_url, authorship_kind, authored_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    entry.id, parentDetailId, nextPosition(db, entry.id, parentDetailId), text,
    fact.kind, fact.baseline, fact.result, fact.myRole, fact.confidential ? 1 : 0,
    fact.evidenceUrl, fact.authorshipKind, fact.authoredBy
  );
  return requireDetail(db, Number(info.lastInsertRowid));
}

/** Update a node's text and/or fact fields (structure is edited via
 * add/remove). Touching a human-authored node's content requires restating
 * authorship — the node records who LAST vouched for it, truthfully. */
function updateWorkDetail(db, { detailId, detail, ...factInput }) {
  const row = requireDetail(db, detailId);
  const providedFactKeys = ['kind', 'baseline', 'result', 'myRole', 'confidential', 'evidenceUrl', 'authorshipKind', 'authoredBy']
    .filter((key) => factInput[key] !== undefined && factInput[key] !== null && factInput[key] !== '');
  const text = detail === undefined || detail === null ? null : String(detail).trim();
  if (text !== null && !text) throw new WorkDetailError('INVALID_ARGUMENT', 'Detail text is required');
  if (text !== null && text.length > MAX_DETAIL_TEXT) throw new WorkDetailError('INVALID_ARGUMENT', `Detail exceeds ${MAX_DETAIL_TEXT} characters`);
  if (text === null && !providedFactKeys.length) {
    throw new WorkDetailError('INVALID_ARGUMENT', 'Nothing to update: pass new text and/or fact fields');
  }
  const merged = normalizeFactFields({
    kind: factInput.kind ?? row.kind,
    baseline: factInput.baseline ?? row.baseline,
    result: factInput.result ?? row.result,
    myRole: factInput.myRole ?? row.my_role,
    confidential: factInput.confidential ?? row.confidential,
    evidenceUrl: factInput.evidenceUrl ?? row.evidence_url,
    authorshipKind: factInput.authorshipKind ?? row.authorship_kind,
    authoredBy: factInput.authoredBy ?? row.authored_by
  });
  const touchesContent = text !== null
    || providedFactKeys.some((key) => !['authorshipKind', 'authoredBy'].includes(key));
  if (row.authorship_kind === 'human' && touchesContent && !factInput.authorshipKind) {
    throw new WorkDetailError(
      'FACT_AUTHORSHIP_REQUIRED',
      'This node is human-authored; changing its content requires restating --authorship-kind and --authored-by for who is vouching now'
    );
  }
  db.prepare(`
    UPDATE profile_work_entry_details
    SET detail=?, kind=?, baseline=?, result=?, my_role=?, confidential=?,
        evidence_url=?, authorship_kind=?, authored_by=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    text ?? row.detail, merged.kind, merged.baseline, merged.result, merged.myRole,
    merged.confidential ? 1 : 0, merged.evidenceUrl, merged.authorshipKind, merged.authoredBy, row.id
  );
  return requireDetail(db, row.id);
}

/** Remove a LEAF node (refuses when children exist) and re-pack positions. */
function removeWorkDetail(db, { detailId }) {
  const row = requireDetail(db, detailId);
  const children = db.prepare('SELECT COUNT(*) AS n FROM profile_work_entry_details WHERE parent_detail_id=?').get(row.id).n;
  if (children > 0) {
    throw new WorkDetailError('HAS_CHILDREN', `Detail ${detailId} has ${children} child node(s); remove them first`);
  }
  db.prepare('DELETE FROM profile_work_entry_details WHERE id=?').run(row.id);
  const siblings = db.prepare(`
    SELECT id FROM profile_work_entry_details
    WHERE work_entry_id=? AND parent_detail_id IS ? ORDER BY position
  `).all(row.work_entry_id, row.parent_detail_id ?? null);
  siblings.forEach((sibling, index) => {
    db.prepare('UPDATE profile_work_entry_details SET position=? WHERE id=?').run(index + 1, sibling.id);
  });
  return { removed: row.id };
}

/** The full outline for a work entry as a nested tree. */
function listWorkOutline(db, workEntryId) {
  const entry = requireWorkEntry(db, workEntryId);
  const rows = db.prepare(`
    SELECT id, parent_detail_id, position, detail, kind, baseline, result, my_role,
      confidential, evidence_url, authorship_kind, authored_by, created_at, updated_at
    FROM profile_work_entry_details WHERE work_entry_id=? ORDER BY parent_detail_id, position
  `).all(entry.id);
  const byParent = new Map();
  for (const row of rows) {
    const key = row.parent_detail_id ?? 0;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(row);
  }
  const build = (parentKey) => (byParent.get(parentKey) || []).map((row) => ({
    id: row.id,
    detail: row.detail,
    position: row.position,
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.baseline ? { baseline: row.baseline } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.my_role ? { myRole: row.my_role } : {}),
    ...(row.confidential ? { confidential: true } : {}),
    ...(row.evidence_url ? { evidenceUrl: row.evidence_url } : {}),
    ...(row.authorship_kind ? { authorshipKind: row.authorship_kind, authoredBy: row.authored_by } : {}),
    children: build(row.id)
  }));
  return { workEntryId: entry.id, roleTitle: entry.role_title, company: entry.company, nodes: build(0), nodeCount: rows.length };
}

// ------------------------------------------------------------- interview ----

/** Split a highlights blob into its bullet strings. */
function highlightBullets(highlights) {
  const text = String(highlights ?? '').trim();
  if (!text) return [];
  const bullets = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s+/, '').trim())
    .filter(Boolean);
  return bullets.length ? bullets : [text];
}

const INTERVIEW_FACT_QUESTIONS = Object.freeze([
  {
    kind: 'scale',
    required: true,
    ask: 'What scale did this operate at — users, requests, data volume, records, sites, team size? Give numbers with units; say "unknown" if genuinely unmeasured.'
  },
  {
    kind: 'outcome',
    required: true,
    ask: 'What was true BEFORE (the measured or observable starting point) and what changed AFTER — in the same unit? Put the before in --baseline and the after in --result.'
  },
  {
    kind: 'constraint',
    required: false,
    ask: 'What made this hard — a deadline, compatibility requirement, budget, on-call load, migration safety? One concrete constraint.'
  },
  {
    kind: 'decision',
    required: false,
    ask: 'What decision did YOU make here that a different engineer might have made differently, and why?'
  }
]);

/**
 * The fact-ledger interview (plan §4): a deterministic, read-only walk of what
 * the ledger still needs for one work entry, one question at a time. Each
 * question carries the exact command that records its answer, so an operator
 * or agent can relay questions to Cole and store the replies verbatim with
 * `--authorship-kind human --authored-by Cole`.
 *
 * Anchors come first: every highlight bullet becomes a root `action` node
 * (imported authorship — the words already existed). Facts come second: each
 * anchor is asked for its ownership verb, scale, and baseline→result outcome
 * (required), then a constraint and a distinguishing decision (optional).
 */
function workEntryInterview(db, { workEntryId, limit = 5 }) {
  const entry = requireWorkEntry(db, workEntryId);
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 5, 20));
  const outline = listWorkOutline(db, entry.id);
  const bullets = highlightBullets(entry.highlights);
  const questions = [];

  const anchors = outline.nodes.filter((node) => node.kind === 'action' || !node.kind);
  const anchorByText = new Map(anchors.map((node) => [node.detail.trim(), node]));

  for (const [index, bullet] of bullets.entries()) {
    if (anchorByText.has(bullet.trim())) continue;
    questions.push({
      step: 'anchor',
      required: true,
      highlightIndex: index,
      highlight: bullet,
      ask: 'Anchor this highlight as a root outline node so facts can attach to it.',
      recordWith: `jobtrack profile add-work-detail --work-entry-id ${entry.id} --kind action `
        + `--authorship-kind imported --authored-by profile-highlights --text ${JSON.stringify(bullet)} --json`
    });
  }

  for (const anchor of anchors) {
    if (!anchor.myRole) {
      questions.push({
        step: 'fact',
        required: true,
        anchorDetailId: anchor.id,
        anchor: anchor.detail,
        kind: 'my_role',
        ask: `Which verb honestly describes your ownership of “${anchor.detail.slice(0, 80)}”: led, owned, designed, co-designed, implemented, or contributed?`,
        recordWith: `jobtrack profile update-work-detail --detail-id ${anchor.id} --kind action --my-role <verb> `
          + '--authorship-kind human --authored-by Cole --json'
      });
    }
    for (const question of INTERVIEW_FACT_QUESTIONS) {
      if (anchor.children.some((child) => child.kind === question.kind)) continue;
      const flags = question.kind === 'outcome'
        ? '--baseline "<before, with unit>" --result "<after, same unit>" '
        : '';
      questions.push({
        step: 'fact',
        required: question.required,
        anchorDetailId: anchor.id,
        anchor: anchor.detail,
        kind: question.kind,
        ask: question.ask,
        recordWith: `jobtrack profile add-work-detail --work-entry-id ${entry.id} --parent-detail-id ${anchor.id} `
          + `--kind ${question.kind} ${flags}--text "<Cole's answer, verbatim>" `
          + '--authorship-kind human --authored-by Cole --json'
      });
    }
  }

  const requiredRemaining = questions.filter((question) => question.required).length;
  return {
    workEntryId: entry.id,
    roleTitle: entry.role_title,
    company: entry.company,
    highlightCount: bullets.length,
    anchorCount: anchors.length,
    requiredRemaining,
    optionalRemaining: questions.length - requiredRemaining,
    complete: requiredRemaining === 0,
    questions: questions.slice(0, boundedLimit)
  };
}

/**
 * Parse an indented plain-text outline into nodes. Two spaces or one tab per
 * level; optional leading "-", "*", or "•" bullets. Blank lines skipped.
 * @param {string} text
 * @returns {Array<{depth: number, detail: string}>}
 */
function parseOutlineText(text) {
  const nodes = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const match = rawLine.match(/^([ \t]*)(?:[-*•]\s+)?(.*)$/);
    const indent = match[1].replace(/\t/g, '  ');
    const depth = Math.floor(indent.length / 2);
    const detail = match[2].trim();
    if (!detail) continue;
    const previousDepth = nodes.length ? nodes[nodes.length - 1].depth : -1;
    if (depth > previousDepth + 1) {
      throw new WorkDetailError('INVALID_ARGUMENT', `Outline line skips levels (depth ${depth} after ${previousDepth}): "${detail.slice(0, 60)}"`);
    }
    if (depth >= MAX_DEPTH) throw new WorkDetailError('INVALID_ARGUMENT', `Outline depth exceeds ${MAX_DEPTH}`);
    nodes.push({ depth, detail });
  }
  if (nodes.length > MAX_OUTLINE_NODES) {
    throw new WorkDetailError('INVALID_ARGUMENT', `Outline exceeds ${MAX_OUTLINE_NODES} nodes`);
  }
  return nodes;
}

/**
 * Import an indented outline under a work entry. Append-only by default;
 * `replace: true` clears the entry's existing outline first (deepest-first).
 */
function importWorkOutline(db, { workEntryId, text, replace = false }) {
  const entry = requireWorkEntry(db, workEntryId);
  const parsed = parseOutlineText(text);
  if (!parsed.length) throw new WorkDetailError('INVALID_ARGUMENT', 'Outline text contains no bullet lines');
  const run = db.transaction(() => {
    if (replace) {
      const existing = db.prepare('SELECT id FROM profile_work_entry_details WHERE work_entry_id=? ORDER BY id DESC').all(entry.id);
      for (const row of existing) db.prepare('DELETE FROM profile_work_entry_details WHERE id=?').run(row.id);
    }
    const parentAtDepth = [];
    let added = 0;
    for (const node of parsed) {
      const parentDetailId = node.depth === 0 ? null : parentAtDepth[node.depth - 1];
      const inserted = addWorkDetail(db, { workEntryId: entry.id, parentDetailId, detail: node.detail });
      parentAtDepth[node.depth] = inserted.id;
      parentAtDepth.length = node.depth + 1;
      added += 1;
    }
    return added;
  });
  const added = run();
  return { workEntryId: entry.id, added, replaced: Boolean(replace) };
}

/** Human-authored, non-confidential ledger nodes for the work entry behind a
 * profile entry — the only nodes citable as bullet evidence
 * (RESUME_QUALITY_PLAN §4/§5). Outline order; the fields are exactly what the
 * generation context exposes and provenance pins. Confidential nodes never
 * leave the store this way; agent/imported nodes are not evidence. */
function listCitableWorkDetails(db, profileEntryId) {
  const has = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (!has('profile_work_entries') || !has('profile_work_entry_details')) return [];
  const work = db.prepare('SELECT id FROM profile_work_entries WHERE profile_entry_id=?').get(profileEntryId);
  if (!work) return [];
  return db.prepare(`
    SELECT id, parent_detail_id, position, detail, kind, baseline, result, my_role, evidence_url, authored_by, updated_at
    FROM profile_work_entry_details
    WHERE work_entry_id=? AND authorship_kind='human' AND COALESCE(confidential,0)=0
    ORDER BY COALESCE(parent_detail_id,0), position, id
  `).all(work.id).map((row) => ({
    id: row.id, parentDetailId: row.parent_detail_id, kind: row.kind, myRole: row.my_role,
    baseline: row.baseline, result: row.result, evidenceUrl: row.evidence_url,
    text: row.detail, authoredBy: row.authored_by, updatedAt: row.updated_at
  }));
}

module.exports = {
  WorkDetailError,
  listCitableWorkDetails,
  DETAIL_KINDS,
  MY_ROLES,
  AUTHORSHIP_KINDS,
  addWorkDetail,
  updateWorkDetail,
  removeWorkDetail,
  listWorkOutline,
  parseOutlineText,
  importWorkOutline,
  workEntryInterview
};
