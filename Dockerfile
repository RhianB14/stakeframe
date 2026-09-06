FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs tsconfig*.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm build

# Portable packages include only their runtime files and production dependencies.
# --legacy supports the existing workspace links without injected dependencies.
FROM build AS packages
COPY scripts/check-deployed-versions.mjs /verification/check-deployed-versions.mjs
RUN pnpm --config.hoist-workspace-packages=false --filter @stakeframe/api --prod deploy --legacy /out/api \
 && pnpm --config.hoist-workspace-packages=false --filter @stakeframe/worker --prod deploy --legacy /out/worker \
 && pnpm --config.hoist-workspace-packages=false --filter @stakeframe/db --prod deploy --legacy /out/migrate \
 && node /verification/check-deployed-versions.mjs /workspace /out/api /out/worker /out/migrate

# These artifacts still require the explicitly local runtime. Publication is separate.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS api
COPY --from=packages --chown=node:node /out/api ./
CMD ["node", "dist/server.js"]

FROM runtime AS worker
COPY --from=packages --chown=node:node /out/worker ./
CMD ["node", "dist/server.js"]

FROM runtime AS migrate
COPY --from=packages --chown=node:node /out/migrate ./
CMD ["node", "dist/migrate-cli.js"]

FROM caddy:2.11.2-alpine@sha256:834468128c7696cec0ceea6172f7d692daf645ae51983ca76e39da54a97c570d AS web
# The local listener uses 8080; remove the binary's low-port capability for cap_drop=ALL.
RUN setcap -r /usr/bin/caddy
COPY --from=build /workspace/apps/web/dist /srv
COPY infra/Caddyfile.dev /etc/caddy/Caddyfile
USER 1000:1000
