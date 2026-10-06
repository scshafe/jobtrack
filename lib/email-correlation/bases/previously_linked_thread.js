'use strict';
const { add, addEvidence } = require('./helpers');
module.exports = {
  name: 'previously_linked_thread', tier: 'exact',
  run(ctx) {
    const ids = ctx.store.priorThreadApplications(ctx.facts.source);
    for (const id of ids) add(ctx, id, this.name, 0.99, ['Provider thread was previously linked']);
    if (ids.length) addEvidence(ctx, 'previous_thread_link', `${ids.length} application link(s)`);
  }
};
