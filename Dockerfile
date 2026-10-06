FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime

ARG JOBTRACK_VERSION=2.0.0
ARG JOBTRACK_REVISION=unknown

LABEL org.opencontainers.image.title="JobTrack Web" \
      org.opencontainers.image.version="${JOBTRACK_VERSION}" \
      org.opencontainers.image.revision="${JOBTRACK_REVISION}"

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    JOBTRACK_HOME=/jobtrack

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY contracts ./contracts
COPY discovery-sandbox ./discovery-sandbox

# The web workspace renders the domain read-only and holds no drafting
# capability. The out-of-process draft runner and its vendored engines
# (vendor/mission-pipeline + vendor/mission-eal, byte-pinned by
# lib/draft-runner/vendor-pin.js) are deliberately absent from this image:
# nothing here may compose prose.
#
# RETENTION: this rm is scoped to the WEB IMAGE ONLY. lib/draft-runner is NOT
# dead code — the live fabric worker (lib/fabric-worker-runner/pipeline.js)
# requires sqlite-pipeline-store + vendor-pin from it, and vendor-pin is the
# sole reader of both vendored trees. See vendor/README.md.
RUN rm -rf ./lib/draft-runner

# Host-side JobTrack sources are intentionally private (often 0600/0700).
# The container runs as the host store owner rather than the image's `node`
# user, so copied application files must remain readable by an arbitrary
# non-root runtime UID. The root filesystem is mounted read-only at runtime.
RUN chmod -R a+rX /app

USER node
EXPOSE 3000

CMD ["npm", "start"]
