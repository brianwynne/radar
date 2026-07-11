# radar-api — multi-stage, non-root, runtime-only. The build context is the repo root
# (docker-compose) because the app now has a workspace-internal dependency, @radar/data
# (persistence). We install the npm workspace at the root so the symlink resolves, build
# @radar/data then @radar/api, and copy both packages' dist plus @radar/data's migrations
# into the runtime image. The same image serves the API (default CMD) and the one-shot
# migrate command (see docker-compose `migrate` service).
# NOTE: not verified in this environment (no Docker); validate `docker compose up --build`
# on a Docker-capable host.

FROM node:18-alpine AS build
WORKDIR /repo
# Manifests first for cached installs.
COPY package.json package-lock.json ./
COPY packages/radar-data/package.json packages/radar-data/
COPY apps/api/package.json apps/api/
RUN npm ci --no-audit --no-fund
# Sources.
COPY packages/radar-data packages/radar-data
COPY apps/api apps/api
RUN npm run build -w @radar/data && npm run build -w @radar/api

FROM node:18-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/radar-data/package.json packages/radar-data/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Built output + migration SQL (resolved at runtime by @radar/data.loadMigrations()).
COPY --from=build /repo/packages/radar-data/dist packages/radar-data/dist
COPY packages/radar-data/migrations packages/radar-data/migrations
COPY --from=build /repo/apps/api/dist apps/api/dist
USER node
WORKDIR /repo/apps/api
EXPOSE 3000
# Use 127.0.0.1 (not localhost): the server binds IPv4 0.0.0.0, but musl may resolve
# localhost to ::1 first, where nothing is listening.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health/live >/dev/null 2>&1 || exit 1
CMD ["node", "dist/server.js"]
