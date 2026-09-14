# Stakeframe — procedimento de rollback de aplicação

Reversão de uma implantação de aplicação (imagens) para uma versão anterior, com
identificação por tag SemVer, digest e commit. Este documento **não autoriza execução em
produção**: rollback é mutação e exige autorização específica por tarefa, como qualquer
deploy. Nesta unidade o procedimento foi apenas documentado, planejado por script e
ensaiado em ambiente local (§7).

## 1. Escopo e regras

- Rollback de **aplicação** = voltar os contêineres para as imagens anteriores
  (digests), sem reverter esquema de banco.
- **Migrações são forward-only.** Se a release em execução já aplicou migrações que a
  release de destino não conhece, o rollback de imagem é **proibido** até que a
  compatibilidade seja comprovada (§4) — reverter esquema só pelo procedimento de
  restauração com backup verificado (`stakeframe-restore`, ver docs de operações).
- Imagens antigas não são removidas do daemon durante janelas de deploy (sem `prune`),
  para que o rollback por digest continue possível.

## 2. Pré-requisitos

1. Registro do deployment atual no Kanban (`docs/RELEASE-TRACEABILITY.md` §5.9) — o
   rollback usa exatamente esses valores como origem.
2. Cópia read-only do `deployment.env` vigente antes de qualquer troca
   (arquivo `deployment.previous.env`, `root:root 0600`, guardado em local privado).
3. Os digests anteriores presentes no daemon (`docker image inspect repo@digest`).

## 3. Como identificar a versão anterior

- cartão Kanban da release atual: campo do digest anterior por serviço;
- `deployment.previous.env` (linhas `*_IMAGE=ghcr.io/...@sha256:...`);
- registro aprovado (`infra/release/approved-*.json`) que autorizou os digests anteriores;
- tag Git anotada + GitHub Release da versão anterior (commit de origem).

## 4. Plano e verificação (somente leitura)

```bash
node scripts/deployment/rollback-plan.mjs \
  --current deployment.env --previous deployment.previous.env --check
```

- emite `ROLLBACK_STEP <serviço> <digest atual> -> <digest anterior>` por serviço
  alterado e os comandos `docker compose ... up -d --no-deps <serviço>`;
- **conjunto obrigatório (fail-closed):** o arquivo atual e o anterior devem conter
  **exatamente os cinco serviços**; o planejador recusa
  `ROLLBACK_CURRENT_INCOMPLETE missing=…`, `ROLLBACK_PREVIOUS_INCOMPLETE missing=…` e
  chaves duplicadas (`PIN_DUPLICATE_KEY`). Um plano só é emitido quando os dois lados
  estão completos;
- recusa (`ROLLBACK_PLAN_REFUSED <código>`, saída 1) quando: algum pin não é
  digest-only do repositório esperado, o arquivo anterior não cobre todos os serviços
  atuais (`ROLLBACK_TARGET_MISSING`) ou o digest anterior não existe no host
  (`ROLLBACK_IMAGE_MISSING`).

**Guard de migrações (obrigatório antes de aplicar):** consulte a contagem aplicada no
banco de produção em modo leitura e compare com a contagem conhecida da release de
destino; a release de destino não pode desconhecer migrações já aplicadas:

```sql
SELECT count(*) , max(created_at) FROM drizzle.__drizzle_migrations;
```

Se a contagem aplicada for maior que a da release de destino, **pare**: rollback de
imagem não é permitido (registre no Kanban e escale a decisão).

## 5. Execução (somente com autorização específica)

1. confirmar versão/commit/digests de origem e destino no cartão do Kanban;
2. restaurar as cinco linhas de imagem em `deployment.env` para os digests anteriores
   (edição atômica; manter `root:root 0600`);
3. subir serviço a serviço, sem tocar dependências:
   `docker compose --env-file /etc/stakeframe/deployment.env -f compose.production.yml
-f compose.integrations.yml -f compose.operations.yml up -d --no-deps <serviço>`;
4. a worker da aplicação permanece no mesmo esquema de contenção já conhecido
   (parar/reativar são janelas próprias).

## 6. Validação pós-rollback

1. `docker compose ... ps` → todos `healthy`, `restarts=0`;
2. `node scripts/deployment-verify.mjs --env-file /etc/stakeframe/deployment.env
--endpoint http://127.0.0.1:<porta> --expect-version <versão anterior>
--expect-commit <sha anterior>` → `DEPLOYMENT_TRACEABILITY_VERIFIED`;
3. sondas read-only do monitor (`/status`) por ≥2 ciclos;
4. registrar no Kanban: versão/digest restaurados, resultado da validação, motivo do
   rollback e pendências (ex.: migrações aplicadas na tentativa revertida).

## 7. Ensaio local (evidência desta unidade)

O ensaio local cobre o mecanismo completo sem tocar produção: duas imagens com estampas
distintas (versão anterior e versão atual), execução da atual, verificação aprovada,
plano de rollback gerado pelo script, troca local para a imagem anterior e verificação
aprovada contra a versão anterior — além da recusa de imagens sem estampilha
(`LABEL_VERSION_MISMATCH`/`APP_VERSION_MISMATCH`) e da recusa de plano sem imagem
disponível (`ROLLBACK_IMAGE_MISSING`).

## 8. Proibições

- rollback sem autorização; rollback com `latest`; edição de `deployment.env` sem backup
  verificado; remoção de imagens antigas durante a janela; reversão de migrações sem o
  procedimento de restauração.
