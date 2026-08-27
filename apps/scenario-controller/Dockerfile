# -----------------------------------------------------------------------------
# Scenario Controller — React console + Node API in one small runtime image.
#
# Build context is apps/scenario-controller, so the image is self-contained and
# does not depend on npm workspace hoisting at the repository root.
#
# Build metadata is baked in as build args and surfaced on /api/version and on
# every telemetry item, which is what makes deployment-correlation possible
# during scenario 03.
# -----------------------------------------------------------------------------

# --- Stage 1: build the React console ----------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /build/frontend
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npx vite build

# --- Stage 2: compile the API ------------------------------------------------
FROM node:22-alpine AS backend
WORKDIR /build/backend
COPY backend/package.json ./
RUN npm install --no-audit --no-fund
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npx tsc -p tsconfig.json

# --- Stage 3: production dependencies only -----------------------------------
FROM node:22-alpine AS deps
WORKDIR /build
COPY backend/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# --- Stage 4: runtime --------------------------------------------------------
FROM node:22-alpine AS runtime

ARG APP_VERSION=0.1.0
ARG IMAGE_TAG=local
ARG GIT_COMMIT=unknown
ARG BUILD_TIMESTAMP=unknown

ENV NODE_ENV=production \
    PORT=8080 \
    APP_VERSION=${APP_VERSION} \
    IMAGE_TAG=${IMAGE_TAG} \
    GIT_COMMIT=${GIT_COMMIT} \
    BUILD_TIMESTAMP=${BUILD_TIMESTAMP}

# tini reaps zombies and forwards signals so SIGTERM shutdown is clean.
RUN apk add --no-cache tini curl

WORKDIR /app
COPY --from=deps /build/node_modules ./node_modules
COPY --from=backend /build/backend/dist ./dist
COPY --from=frontend /build/frontend/dist ./dist/public
COPY backend/package.json ./package.json

# The controller writes scenario state and logs to the mounted demo disk, so it
# runs as a non-root user that owns nothing outside /app.
#
# The UID is explicit and numeric because Kubernetes' runAsNonRoot check cannot
# resolve a username to a UID from the image, and rejects the pod with
# CreateContainerConfigError if USER is a name.
RUN addgroup -S -g 10001 sre && adduser -S -u 10001 -G sre sre && chown -R 10001:10001 /app
USER 10001

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
