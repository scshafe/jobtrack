FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    jq \
    poppler-utils \
    qpdf \
    texlive-fonts-recommended \
    texlive-latex-base \
    texlive-latex-recommended \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /input /output /opt/jobtrack-renderer \
  && chmod 0555 /input /output /opt/jobtrack-renderer

COPY render.sh /opt/jobtrack-renderer/render.sh
RUN chmod 0555 /opt/jobtrack-renderer/render.sh

ENTRYPOINT ["/opt/jobtrack-renderer/render.sh"]
