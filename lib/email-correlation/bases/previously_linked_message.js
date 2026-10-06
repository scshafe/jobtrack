'use strict';
const { add, addEvidence } = require('./helpers');
module.exports = {
  name: 'previously_linked_message', tier: 'exact',
  run(ctx) {
    const ids = ctx.store.priorMessageApplications(ctx.facts.source);
    for (const id of ids) add(ctx, id, this.name, 1, ['Provider message was already linked']);
    if (ids.length) addEvidence(ctx, 'previous_message_link', `${ids.length} application link(s)`);
  }
};
