# =========================================================================
# KubePulse image — one Dockerfile, three releases via build args:
#   v1: docker build --build-arg APP_VERSION=1.0.0 -t kubepulse:1.0.0 .
#   v2: docker build --build-arg APP_VERSION=2.0.0 -t kubepulse:2.0.0 .
#   v3: docker build --build-arg APP_VERSION=3.0.0 --build-arg BROKEN=true \
#         -t kubepulse:3.0.0-broken .      (never becomes Ready: rollout-failure demo)
# MCA Trimester 5 - DevOps Lab 5 — Achindra Sharma (2547105)
# =========================================================================
FROM node:22-alpine

ARG APP_VERSION=1.0.0
ARG BROKEN=false

LABEL org.opencontainers.image.title="KubePulse" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.authors="Achindra Sharma <2547105>"

ENV NODE_ENV=production \
    PORT=3000 \
    APP_VERSION=${APP_VERSION} \
    BROKEN=${BROKEN}

WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node public ./public

# Numeric UID 1000 == "node". Kubernetes runAsNonRoot can only verify numeric users.
USER 1000

EXPOSE 3000

# Used by plain `docker run` only — Kubernetes ignores HEALTHCHECK and uses its own probes.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
