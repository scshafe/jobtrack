'use strict';

// resume-contact-block.js — the template-generated header (resume.standard.v4).
//
// A worker never authors the name or contact line: the CLI reads the approved
// profile contact record and the GitHub/LinkedIn profile links from the store
// and injects them as `payload.contact` at draft and preflight time. The stored
// payload therefore reproduces the immutable LaTeX bytes, exactly as the
// editorial context requires, while the model owns only the substance.

const { CONTACT_V4_KEYS } = require('./material-templates');

class ResumeContactBlockError extends Error {
  constructor(code, message) { super(message); this.name = 'ResumeContactBlockError'; this.code = code; }
}

const WORKER_FORBIDDEN_KEYS = Object.freeze(['contact', 'name', 'contactLine', 'contactLinks']);

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/** The approved contact block: name, email and location from profile_contact,
 * the first GitHub and LinkedIn profile links. Phone, address and every other
 * private field are deliberately not read. */
function readProfileContactBlock(db) {
  if (!tableExists(db, 'profile_contact')) throw new ResumeContactBlockError('PROFILE_CONTACT_MISSING', 'No profile contact record exists in this store');
  const contact = db.prepare('SELECT name, email, location FROM profile_contact ORDER BY id LIMIT 1').get();
  if (!contact || !String(contact.name || '').trim()) throw new ResumeContactBlockError('PROFILE_CONTACT_MISSING', 'The profile contact record has no name; set it with `jobtrack profile set-contact`');
  const link = (kind) => tableExists(db, 'profile_links')
    ? db.prepare('SELECT url FROM profile_links WHERE lower(kind)=? ORDER BY id LIMIT 1').get(kind)?.url ?? null
    : null;
  const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return Object.fromEntries(CONTACT_V4_KEYS.map((key) => [key, {
    name: clean(contact.name), email: clean(contact.email), location: clean(contact.location),
    github: clean(link('github')), linkedin: clean(link('linkedin'))
  }[key]]));
}

/** For resume.standard.v4, replace any worker-authored header with the store's
 * approved contact block; other templates pass through untouched. */
function injectProfileContact(db, templateKey, payload) {
  if (templateKey !== 'resume.standard.v4') return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const authored = WORKER_FORBIDDEN_KEYS.filter((key) => Object.hasOwn(payload, key));
  if (authored.length) {
    throw new ResumeContactBlockError('TEMPLATE_CONTACT_NOT_AUTHORED',
      `resume.standard.v4 generates the header from the profile contact record; remove ${authored.join(', ')} from the payload`);
  }
  return { contact: readProfileContactBlock(db), ...payload };
}

module.exports = { ResumeContactBlockError, WORKER_FORBIDDEN_KEYS, readProfileContactBlock, injectProfileContact };
