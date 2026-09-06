FROM restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 AS restic
FROM postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15
COPY --from=restic /usr/bin/restic /usr/local/bin/restic
COPY scripts/recovery /tools
COPY tests/recovery /fixtures
COPY packages/db/migrations /migrations
RUN mkdir /repository /work && chown postgres:postgres /repository /work \
    && chmod 700 /repository /work \
    && find /tools /fixtures -type f -name '*.sh' -exec sed -i 's/\r$//' {} + \
    && sed -i 's/\r$//' /fixtures/failing-bin/pg_dump \
    && chmod +x /fixtures/failing-bin/pg_dump
USER postgres
WORKDIR /work
ENTRYPOINT ["sh", "/tools/drill-command.sh"]
