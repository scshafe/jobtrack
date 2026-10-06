'use strict';

// profile-material-masters.js — the versioned master payload per material kind
// (RESUME_QUALITY_PLAN.md §6, plan L5).
//
// WHY: "Tailoring is selection over a master, not regeneration." A master is
// the human-approved superset of what any application variant may say; a
// variant selects and reorders master content instead of writing fresh prose,
// which structurally prevents invention — a variant can only contain what the
// master and the fact ledger already contain. Today the divergence check is an
// editorial lint warning (MASTER_DIVERGENCE); per-bullet provenance hardening
// arrives with the Phase 4 schema.
//
// Masters are HUMAN-authored by definition: recording a version is the
// human-approval act, exactly as `reviewedBy` is elsewhere (plan L8 applies —
// it is attestation, not authentication). An agent may prepare the payload
// file; only a human decision records it. Versions are append-only and dense
// per kind; the current master is simply the latest version.

const crypto = require('node:crypto');

const MASTER_KINDS = Object.freeze(['resume', 'cover-letter']);
const MAX_PAYLOAD_BYTES = 256 * 1024;

class MaterialMasterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MaterialMasterError';
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function ensureMaterialMasterSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_material_masters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('resume','cover-letter')),
      version INTEGER NOT NULL CHECK (version>=1),
      template_key TEXT NOT NULL CHECK (trim(template_key)<>''),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256)=64),
      authorship_kind TEXT NOT NULL CHECK (authorship_kind='human'),
      authored_by TEXT NOT NULL CHECK (trim(authored_by)<>''),
      change_note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      uuid TEXT,
      UNIQUE(kind, version)
    );
    CREATE INDEX IF NOT EXISTS idx_material_masters_kind
      ON profile_material_masters(kind, version DESC);
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_material_masters_immutable_update
      BEFORE UPDATE ON profile_material_masters
      WHEN NEW.payload_json IS NOT OLD.payload_json
        OR NEW.kind IS NOT OLD.kind
        OR NEW.version IS NOT OLD.version
        OR NEW.template_key IS NOT OLD.template_key
        OR NEW.payload_sha256 IS NOT OLD.payload_sha256
        OR NEW.authored_by IS NOT OLD.authored_by
        OR NEW.authorship_kind IS NOT OLD.authorship_kind
      BEGIN SELECT RAISE(ABORT,'profile_material_masters versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_material_masters_immutable_delete
      BEFORE DELETE ON profile_material_masters
      BEGIN SELECT RAISE(ABORT,'profile_material_masters versions are immutable'); END;
  `);
}

/**
 * Record a new master version. The payload must expand cleanly through the
 * named template (hard validation), and the write is the human-approval act.
 */
function setMaterialMaster(db, input) {
  ensureMaterialMasterSchema(db);
  const kind = String(input.kind || '').trim();
  if (!MASTER_KINDS.includes(kind)) {
    throw new MaterialMasterError('INVALID_KIND', `Master kind must be one of: ${MASTER_KINDS.join(', ')}`);
  }
  const templateKey = String(input.templateKey || '').trim();
  if (!templateKey) throw new MaterialMasterError('INVALID_INPUT', 'A template key is required');
  const authoredBy = String(input.authoredBy || '').trim();
  if (!authoredBy) throw new MaterialMasterError('MASTER_REQUIRES_HUMAN', 'Recording a master is a human decision; --authored-by must name the human');
  if (input.authorshipKind !== undefined && input.authorshipKind !== 'human') {
    throw new MaterialMasterError('MASTER_REQUIRES_HUMAN', 'Masters are human-authored by definition');
  }
  const payload = input.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new MaterialMasterError('INVALID_INPUT', 'The master payload must be a JSON object');
  }
  const payloadJson = canonicalJson(payload);
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new MaterialMasterError('INVALID_INPUT', `Master payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  // Hard validation: the payload must be renderable substance, not prose in a
  // trench coat. Expansion throws on any shape violation.
  const { expandMaterialTemplate } = require('./material-templates');
  expandMaterialTemplate(templateKey, payload, kind);
  const { lintTemplatePayload } = require('./resume-lint');
  const payloadLint = lintTemplatePayload(templateKey, kind, payload);

  const payloadSha256 = sha256(payloadJson);
  const current = db.prepare('SELECT id, version, payload_sha256 FROM profile_material_masters WHERE kind=? ORDER BY version DESC LIMIT 1').get(kind);
  if (current && current.payload_sha256 === payloadSha256) {
    return { master: getMaterialMaster(db, kind, current.version), payloadLint, unchanged: true };
  }
  const version = (current?.version || 0) + 1;
  db.prepare(`
    INSERT INTO profile_material_masters(kind, version, template_key, payload_json, payload_sha256, authorship_kind, authored_by, change_note)
    VALUES (?,?,?,?,?,'human',?,?)
  `).run(kind, version, templateKey, payloadJson, payloadSha256, authoredBy, input.changeNote ? String(input.changeNote).slice(0, 2000) : null);
  return { master: getMaterialMaster(db, kind, version), payloadLint, unchanged: false };
}

/** The master for a kind — latest version, or an exact one. Null when absent. */
function getMaterialMaster(db, kind, version = null) {
  if (!tableExists(db, 'profile_material_masters')) return null;
  const row = version
    ? db.prepare('SELECT * FROM profile_material_masters WHERE kind=? AND version=?').get(kind, version)
    : db.prepare('SELECT * FROM profile_material_masters WHERE kind=? ORDER BY version DESC LIMIT 1').get(kind);
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload_json) };
}

/** Version metadata per kind, newest first — payloads elided. */
function listMaterialMasters(db) {
  if (!tableExists(db, 'profile_material_masters')) return [];
  return db.prepare(`
    SELECT id, kind, version, template_key, payload_sha256, authored_by, change_note, created_at
    FROM profile_material_masters ORDER BY kind, version DESC
  `).all();
}

/** Master bullet strings for divergence comparison, whitespace-normalized. */
function masterBulletTexts(master) {
  if (!master?.payload) return [];
  const bullets = [];
  const push = (list) => Array.isArray(list) && list.forEach((text) => bullets.push(String(text).replace(/\s+/g, ' ').trim()));
  (Array.isArray(master.payload.experience) ? master.payload.experience : []).forEach((entry) => push(entry?.bullets));
  (Array.isArray(master.payload.projects) ? master.payload.projects : []).forEach((entry) => push(entry?.bullets));
  (Array.isArray(master.payload.education) ? master.payload.education : []).forEach((entry) => push(entry?.notes));
  return bullets;
}

module.exports = {
  MASTER_KINDS,
  MaterialMasterError,
  ensureMaterialMasterSchema,
  setMaterialMaster,
  getMaterialMaster,
  listMaterialMasters,
  masterBulletTexts
};
