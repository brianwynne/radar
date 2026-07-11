# radar-web — static SPA built with Vite, served by non-root nginx. Build context is the
# repo root (docker-compose). radar-web has no workspace-internal dependencies (it calls
# radar-api over HTTP), so only its manifest is needed for the install.
# NOTE: not verified in this environment (no Docker); validate `docker compose up --build`
# on a Docker-capable host.

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build -w @radar/web

# nginx-unprivileged listens on 8080 as a non-root user — suits read_only + dropped caps.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
