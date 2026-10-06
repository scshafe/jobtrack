'use strict';

const { classifySenderDomain } = require('./domain-classes');

function identifySender(signals, store) {
  const domainClass = classifySenderDomain(store.db, signals.sender.domain);
  const contact = uniqueSorted(store.companiesByContact(signals.sender.address));
  if (contact.length) return identity(contact, 'contact', 0.9, domainClass);

  if (domainClass === 'corporate') {
    const domain = uniqueSorted(store.companiesByDomain(signals.sender.domain));
    if (domain.length) return identity(domain, 'domain', 0.75, domainClass);
  }

  if (signals.company.domain && signals.company.domain !== signals.sender.domain) {
    const factDomain = uniqueSorted(store.companiesByDomain(signals.company.domain));
    if (factDomain.length) return identity(factDomain, 'domain', 0.7, domainClass);
  }

  const mention = uniqueSorted(store.companiesByName(signals.company.name));
  if (mention.length) return identity(mention, 'mention', 0.6, domainClass);
  return identity([], 'none', 0, domainClass);
}

function identity(companyIds, basis, confidence, domainClass) {
  return Object.freeze({ companyIds, basis, confidence, domainClass });
}

function publicIdentity(value) {
  return {
    companyIds: [...value.companyIds],
    basis: value.basis,
    confidence: value.confidence
  };
}

function uniqueSorted(values) {
  return [...new Set(values.map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
}

module.exports = { identifySender, publicIdentity };
