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
 && pnpm --config.hoist-workspace-packages=false --filter @stakeframe/ops --prod deploy --legacy /out/ops \
 && node /verification/check-deployed-versions.mjs /workspace /out/api /out/worker /out/migrate /out/ops

# Runtime selection is explicit; production enforces its authentication/secret contract.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime
# Release metadata is stamped by the build from the single source of truth (root
# package.json `version` + build inputs); missing values stay explicit markers so an
# unstamped artifact is refused downstream instead of being mistaken for a release.
# api/worker/migrate inherit these variables and labels.
ARG STAKEFRAME_VERSION=unversioned
ARG STAKEFRAME_COMMIT=unknown
ARG STAKEFRAME_BUILD_DATE=unknown
ENV NODE_ENV=production \
    STAKEFRAME_VERSION=${STAKEFRAME_VERSION} \
    STAKEFRAME_COMMIT=${STAKEFRAME_COMMIT} \
    STAKEFRAME_BUILD_DATE=${STAKEFRAME_BUILD_DATE}
LABEL org.opencontainers.image.title="Stakeframe" \
      org.opencontainers.image.description="Stakeframe application image" \
      org.opencontainers.image.source="https://github.com/RhianB14/stakeframe" \
      org.opencontainers.image.revision=${STAKEFRAME_COMMIT} \
      org.opencontainers.image.version=${STAKEFRAME_VERSION} \
      org.opencontainers.image.created=${STAKEFRAME_BUILD_DATE}
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

FROM restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 AS restic
FROM postgres:18.4-bookworm@sha256:882236b897e39051d2368c5ccc6cda944904723506b2dfc97f2a8f5bc9afa382 AS operations
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=restic /usr/bin/restic /usr/local/bin/restic
COPY --from=packages --chown=1000:1000 /out/ops /app
RUN node --version && pg_dump --version && restic version \
 && mkdir /work /status /repository && chown 1000:1000 /work /status /repository && chmod 700 /work /status /repository
ARG STAKEFRAME_VERSION=unversioned
ARG STAKEFRAME_COMMIT=unknown
ARG STAKEFRAME_BUILD_DATE=unknown
LABEL org.opencontainers.image.title="Stakeframe" \
      org.opencontainers.image.description="Stakeframe operations image" \
      org.opencontainers.image.source="https://github.com/RhianB14/stakeframe" \
      org.opencontainers.image.revision=${STAKEFRAME_COMMIT} \
      org.opencontainers.image.version=${STAKEFRAME_VERSION} \
      org.opencontainers.image.created=${STAKEFRAME_BUILD_DATE}
ENV NODE_ENV=production
WORKDIR /app
USER 1000:1000
ENTRYPOINT ["node"]
CMD ["src/server.mjs", "daemon"]

FROM caddy:2.11.2-alpine@sha256:834468128c7696cec0ceea6172f7d692daf645ae51983ca76e39da54a97c570d AS web
# The local listener uses 8080; remove the binary's low-port capability for cap_drop=ALL.
RUN setcap -r /usr/bin/caddy
COPY --from=build /workspace/apps/web/dist /srv
COPY infra/Caddyfile.dev /etc/caddy/Caddyfile
USER 1000:1000
ARG STAKEFRAME_VERSION=unversioned
ARG STAKEFRAME_COMMIT=unknown
ARG STAKEFRAME_BUILD_DATE=unknown
LABEL org.opencontainers.image.title="Stakeframe" \
      org.opencontainers.image.description="Stakeframe web image" \
      org.opencontainers.image.source="https://github.com/RhianB14/stakeframe" \
      org.opencontainers.image.revision=${STAKEFRAME_COMMIT} \
      org.opencontainers.image.version=${STAKEFRAME_VERSION} \
      org.opencontainers.image.created=${STAKEFRAME_BUILD_DATE}

FROM web AS web-production
USER root
RUN mkdir -p /data/caddy /config/caddy && chown -R 1000:1000 /data/caddy /config/caddy
COPY infra/Caddyfile.production /etc/caddy/Caddyfile
COPY infra/production/tls.conf /etc/caddy/tls.conf
USER 1000:1000
