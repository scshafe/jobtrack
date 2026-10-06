'use strict';

// Process capabilities a host may withhold from the fabric tick.
//
// The LaTeX renderer is a pinned container run through the host's Docker
// daemon (lib/latex-renderer.js). A host or container that has no Docker
// daemon, or no reviewed renderer image for its platform, sets
// JOBTRACK_RENDERER=off: the tick then receives no renderer and reports a
// needed render as dispatchable work with its reason ("renderer unavailable
// in this process"), instead of failing the same render on every pass. The
// jobtrack-worker image sets it (docs/move-write-side-to-lubuntu.md): it has
// no Docker socket, and the renderer pin is the Mini's arm64 build.
function rendererDisabled(env = process.env) {
  return String(env.JOBTRACK_RENDERER ?? '').trim().toLowerCase() === 'off';
}

module.exports = { rendererDisabled };
