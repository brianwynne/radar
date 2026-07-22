# radar-web — static SPA built with Vite, served by non-root nginx. Build context is the
# repo root (docker-compose). radar-web depends on the workspace package @radar/shed (the
# shed gating core), so its manifest + source are installed/built before the web build.
# NOTE: not verified in this environment (no Docker); validate `docker compose up --build`
# on a Docker-capable host.

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/radar-shed/package.json packages/radar-shed/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages/radar-shed packages/radar-shed
COPY apps/web apps/web
RUN npm run build -w @radar/shed && npm run build -w @radar/web

# nginx-unprivileged listens on 8080 as a non-root user — suits read_only + dropped caps.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
