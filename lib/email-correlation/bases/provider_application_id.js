'use strict';
const { add, addEvidence } = require('./helpers');
module.exports = {
  name: 'provider_application_id', tier: 'exact',
  run(ctx) {
    const seen = new Set();
    for (const reference of ctx.facts.applicationRefs || []) {
      const namespace = String(reference.namespace).trim().toLowerCase();
      const value = String(reference.value).trim();
      const key = `${namespace}\u0000${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ids = ctx.store.applicationsByExternalIdentifier(namespace, value);
      for (const id of ids) add(ctx, id, this.name, 1, [`Exact ${namespace} application identifier`]);
      if (ids.length) addEvidence(ctx, 'application_identifier', namespace);
    }
  }
};
