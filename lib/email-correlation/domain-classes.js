'use strict';
// lib/email-correlation/domain-classes.js — which kind of sender a domain names.
//
// The correlation design (docs/DESIGN-EMAIL-CORRELATION.md §S2) needs one
// answer per inbound message: does the sender's domain identify the employer
// (`corporate`), a hiring tool that mails on employers' behalf (`ats`), or
// nobody at all (`consumer`)? The class is DERIVED from the domain with a
// shared, versioned rule set — contracts/email/sender-domain-classes.v1.json,
// byte-identical to inbox-pipeline's src/data/sender-domain-classes.json — so
// the extractor (inbox) and the learner (here) agree on what a domain means.
//
// At runtime append-only operator facts are consulted first. The seeded
// `email_domain_classes` table stays immutable provenance and is the fallback.

const path = require('node:path');

const RULE_SET_PATH = path.resolve(__dirname, '..', '..', 'contracts', 'email', 'sender-domain-classes.v1.json');
const RULE_SET = Object.freeze(require(RULE_SET_PATH));

const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function normalizeDomain(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, '');
  return DOMAIN_PATTERN.test(trimmed) ? trimmed : '';
}

/** True when `domain` is `suffix` or a subdomain of it, on a dot boundary. */
function domainMatches(domain, suffix) {
  return domain === suffix || domain.endsWith(`.${suffix}`);
}

function classifyWithRuleSet(domain) {
  if (RULE_SET.ats.some((entry) => domainMatches(domain, entry))) return 'ats';
  if (RULE_SET.consumer.some((entry) => domainMatches(domain, entry))) return 'consumer';
  return 'corporate';
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/**
 * Classify a sender domain: the store's `email_domain_classes` rows win (a
 * listed domain or any of its parents), then the shared rule set.
 * @returns {'corporate'|'ats'|'consumer'|'unknown'}
 */
function classifySenderDomainWithProvenance(db, raw) {
  const domain = normalizeDomain(raw);
  if (domain === '') return { class: 'unknown', source: 'none', matchedDomain: null };
  if (db) {
    const labels = domain.split('.');
    for (let index = 0; index < labels.length - 1; index += 1) {
      const candidate = labels.slice(index).join('.');
      if (tableExists(db, 'email_identity_registry_facts')) {
        const override = db.prepare(`
          SELECT addition.id,addition.domain_class AS class
          FROM email_identity_registry_facts addition
          WHERE addition.operation='add' AND addition.kind='domain_class'
            AND addition.normalized_value=?
            AND NOT EXISTS (
              SELECT 1 FROM email_identity_registry_facts retraction
              WHERE retraction.operation='retract' AND retraction.target_fact_id=addition.id
            )
          ORDER BY addition.id DESC LIMIT 1
        `).get(candidate);
        if (override) return { class: override.class, source: `operator-fact:${override.id}`, matchedDomain: candidate };
      }
      if (tableExists(db, 'email_domain_classes')) {
        const row = db.prepare('SELECT class,source FROM email_domain_classes WHERE domain=?').get(candidate);
        if (row) return { class: row.class, source: row.source, matchedDomain: candidate };
      }
    }
  }
  return { class: classifyWithRuleSet(domain), source: `rule-set:${RULE_SET.ruleSetVersion}`, matchedDomain: domain };
}

function classifySenderDomain(db, raw) {
  return classifySenderDomainWithProvenance(db, raw).class;
}

module.exports = {
  RULE_SET,
  RULE_SET_PATH,
  classifySenderDomain,
  classifySenderDomainWithProvenance,
  domainMatches,
  normalizeDomain
};
