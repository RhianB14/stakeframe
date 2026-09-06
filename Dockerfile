FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# Local M0 images. Deployment and production image publication are separate tasks.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace /workspace
USER node

FROM runtime AS api
CMD ["node", "apps/api/dist/server.js"]

FROM runtime AS worker
CMD ["node", "apps/worker/dist/server.js"]

FROM caddy:2.11.2-alpine@sha256:834468128c7696cec0ceea6172f7d692daf645ae51983ca76e39da54a97c570d AS web
# The local listener uses 8080; remove the binary's low-port capability for cap_drop=ALL.
RUN setcap -r /usr/bin/caddy
COPY --from=build /workspace/apps/web/dist /srv
COPY infra/Caddyfile.dev /etc/caddy/Caddyfile
USER 1000:1000
