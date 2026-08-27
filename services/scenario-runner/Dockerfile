# -----------------------------------------------------------------------------
# scenario-runner — in-cluster fault agent.
#
# Reached only from the Scenario Controller over an internal load balancer and
# authenticated with a shared token. Runs as a non-root user with a
# namespace-scoped Kubernetes Role.
# -----------------------------------------------------------------------------

FROM node:22-alpine AS build
WORKDIR /build
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine AS deps
WORKDIR /build
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime

ARG IMAGE_TAG=local
ARG GIT_COMMIT=unknown
ARG BUILD_TIMESTAMP=unknown

ENV NODE_ENV=production \
    PORT=8090 \
    IMAGE_TAG=${IMAGE_TAG} \
    GIT_COMMIT=${GIT_COMMIT} \
    BUILD_TIMESTAMP=${BUILD_TIMESTAMP}

RUN apk add --no-cache tini curl

WORKDIR /app
COPY --from=deps /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./package.json

# Numeric UID: Kubernetes runAsNonRoot cannot verify a username-based USER.
RUN addgroup -S -g 10001 sre && adduser -S -u 10001 -G sre sre && chown -R 10001:10001 /app
USER 10001

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=8s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8090/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
