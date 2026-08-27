# -----------------------------------------------------------------------------
# Magic 8 Ball — React UI + API + TLS termination in one small image.
#
# The same image serves both the "stable" and the "bad" variant of scenario 03.
# The difference is the FAULT_MODE build arg baked into the image, plus distinct
# build metadata, so a rollback is a real image change with a real version delta
# to correlate against — not a runtime toggle that would leave no deployment
# trail for an investigation to find.
# -----------------------------------------------------------------------------

FROM node:22-alpine AS frontend
WORKDIR /build/frontend
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npx vite build

FROM node:22-alpine AS backend
WORKDIR /build/backend
COPY backend/package.json ./
RUN npm install --no-audit --no-fund
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine AS deps
WORKDIR /build
COPY backend/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime

ARG APP_VERSION=0.1.0
ARG IMAGE_TAG=local
ARG GIT_COMMIT=unknown
ARG BUILD_TIMESTAMP=unknown
# "stable" or "bad" — selects the scenario 03 variant at build time.
ARG FAULT_MODE=stable

ENV NODE_ENV=production \
    PORT=8080 \
    HTTPS_PORT=8443 \
    TLS_DIR=/etc/magic8ball/tls \
    APP_VERSION=${APP_VERSION} \
    IMAGE_TAG=${IMAGE_TAG} \
    GIT_COMMIT=${GIT_COMMIT} \
    BUILD_TIMESTAMP=${BUILD_TIMESTAMP} \
    FAULT_MODE=${FAULT_MODE}

RUN apk add --no-cache tini curl

WORKDIR /app
COPY --from=deps /build/node_modules ./node_modules
COPY --from=backend /build/backend/dist ./dist
COPY --from=frontend /build/frontend/dist ./dist/public
COPY backend/package.json ./package.json

RUN addgroup -S sre && adduser -S -G sre sre && chown -R sre:sre /app
USER sre

EXPOSE 8080 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=8s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
