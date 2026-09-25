# Runbook — migração de schema (etapa separada da promoção; STK-F1-12)

> A migração **nunca roda junto da promoção**. Cada execução exige autorização
> específica do orquestrador nomeando: commit e digest do target `migrate`,
> direção (forward-only), evidência de backup recuperável, janela e critério de
> retorno. `MIGRATION_CONFIRM=production` confirma a intenção do operador — não
> é autorização nem prova de backup.

## 1. Invariantes

1. **Forward-only**: migrações não se revertem por imagem nem por DDL manual;
   reverter esquema só pelo procedimento de recuperação com backup verificado
   ([RECOVERY.md](../RECOVERY.md)) e autorização própria.
2. **Sem retry e sem rollback automáticos**: o primeiro erro interrompe e
   retorna ao orquestrador.
3. **Imagens por digest**, nunca `latest`; a imagem de migração é o target
   `migrate` construído pela CI para o mesmo SHA do deployment.
4. **Hardening preservado**: `compose.migration.yml` espelha o bloco `migrate`
   de `compose.production.yml` (`read_only`, `tmpfs: [/tmp]`, `cap_drop: [ALL]`,
   `no-new-privileges`, limites de CPU/memória/PIDs, segredo em arquivo) e
   une-se apenas à rede interna `backend` da stack.
5. A subida normal dos serviços **não migra** — o perfil `migration` do
   compose de produção continua impedindo migração no startup.

## 2. Pré-requisitos (antes da janela)

- [ ] Autorização específica recebida (SHA, digest do `migrate`, janela);
- [ ] `docker compose --env-file /etc/stakeframe/deployment.env -f compose.production.yml ps`
      → PostgreSQL `healthy` (a execução não tem `depends_on`: o gate é humano);
- [ ] backup recuperável: janela do backup confirmada e condição de restauração
      registradas (nesta fase, a restauração com dados de produção ainda é
      pendência declarada em [DEPLOYMENT.md](../DEPLOYMENT.md) — registrá-la na
      autorização quando for o caso);
- [ ] `node scripts/deployment-check.mjs /etc/stakeframe/deployment.env ...`
      sem desvios;
- [ ] **Guard de contagem** (leitura no banco de produção):

  ```sql
  SELECT count(*), max(created_at) FROM drizzle.__drizzle_migrations;
  ```

  comparar com a contagem conhecida da release de destino; se o banco já
  aplicou migrações que a release de destino desconhece, **pare** e escale.

## 3. Execução (somente na janela autorizada)

Fixar o digest do migrador no arquivo privado e confirmar a intenção da janela
na variável de execução (a variável por execução não é persistida no arquivo):

```bash
cd /opt/stakeframe   # checkout revisado na VPS
docker compose --env-file /etc/stakeframe/deployment.env -f compose.migration.yml \
  run --rm -e MIGRATION_CONFIRM=production migrate
```

- o comando roda **apenas** o alvo `migrate`, com o hardening e a rede do
  `compose.migration.yml`;
- a execução usa o lock advisory e os limites de tempo do migrador;
- o caminho legado (`--profile migration` no compose de produção) permanece
  documentado em [DEPLOYMENT.md](../DEPLOYMENT.md); o `compose.migration.yml` é
  o caminho padrão desta unidade;
- **sem retry automático**: se a saída indicar falha, siga o §5.

## 4. Verificação pós-migração

- [ ] saída do migrador sem erro; registrar aplicadas/pendentes;
- [ ] `SELECT count(*), max(created_at) FROM drizzle.__drizzle_migrations;`
      confere com a release de destino;
- [ ] serviços permanecem `healthy`, `restarts=0`;
- [ ] logs do migrador e da API sem erro novo de schema;
- [ ] quando a janela incluir troca de imagens: `deployment-verify.mjs`
      conforme [promotion-runbook.md](promotion-runbook.md) §3.6;
- [ ] registro no Kanban (§5.9 de [RELEASE-TRACEABILITY.md](../RELEASE-TRACEABILITY.md)):
      SHA, digest do migrate, contagens antes/depois, janela, resultado.

## 5. Falha, aborto e retorno

1. **Pare** no primeiro erro; não repetir automaticamente, não editar o banco
   à mão, não rodar `down --volumes`;
2. Preservar evidências (saída completa, logs, contagens) e registrar no
   Kanban;
3. Devolver ao orquestrador; a decisão de restaurar exige procedimento de
   recuperação com backup verificado e autorização separada
   ([RECOVERY.md](../RECOVERY.md));
4. Reversão de imagem após migração aplicada segue o guard de
   [ROLLBACK.md](../ROLLBACK.md) §4.

## 6. Proibições

- migração fora de janela autorizada, em lote com a promoção, ou por retry
  automático;
- `latest` ou tag móvel para a imagem de migração;
- DDL manual no banco, `down --volumes` ou remoção de volume como reação;
- segredos ou chaves em repositório, card ou log — apenas referências de nome
  (`MIGRATE_IMAGE`, `MIGRATION_CONFIRM`, `SECRET_DIRECTORY`, `DEPLOYMENT_ID`).
