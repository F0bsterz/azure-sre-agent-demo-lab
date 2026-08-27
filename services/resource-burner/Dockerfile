# -----------------------------------------------------------------------------
# resource-burner — bounded CPU/memory pressure workload for scenario 02.
#
# No dependencies and no build step: the whole workload is one file, which keeps
# the image small and makes it obvious by inspection that it cannot do anything
# beyond consume its own reserved budget.
# -----------------------------------------------------------------------------

FROM node:22-alpine

ARG IMAGE_TAG=local
ARG GIT_COMMIT=unknown
ARG BUILD_TIMESTAMP=unknown

ENV NODE_ENV=production \
    MEMORY_MB=256 \
    CPU_PERCENT=85 \
    IMAGE_TAG=${IMAGE_TAG} \
    GIT_COMMIT=${GIT_COMMIT} \
    BUILD_TIMESTAMP=${BUILD_TIMESTAMP}

RUN apk add --no-cache tini

WORKDIR /app
COPY burn.js ./burn.js

# Numeric UID: Kubernetes runAsNonRoot cannot verify a username-based USER.
RUN addgroup -S -g 10001 sre && adduser -S -u 10001 -G sre sre
USER 10001

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "burn.js"]
