# radar-api — multi-stage, non-root, runtime-only. Build context is the repo root
# (docker-compose), but the app has no workspace-internal dependencies yet, so it is
# built standalone from apps/api. NOTE: not verified in this environment (no Docker);
# validate `docker compose up --build` on a Docker-capable host.

FROM node:18-alpine AS build
WORKDIR /app
COPY apps/api/package.json ./
RUN npm install --no-audit --no-fund
COPY apps/api/tsconfig.json ./
COPY apps/api/src ./src
RUN npm run build

FROM node:18-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY apps/api/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://localhost:3000/api/v1/health/live >/dev/null 2>&1 || exit 1
CMD ["node", "dist/server.js"]
