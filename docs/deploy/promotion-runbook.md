# Runbook — promoção manual por digest (STK-F1-12)

> Procedimento manual. Nada aqui executa sozinho: cada janela exige autorização
> específica do orquestrador nomeando commit, digests, migrações previstas,
> evidência de backup e janela (Plano Master §12.2). Os workflows de CI preparam
> e publicam candidatos e registram a aprovação do proprietário; a promoção em
> si é sempre SSH manual, serviço a serviço, por digest.

## 1. Invariantes

1. Consumo **sempre por digest** (`repo@sha256:…`), **nunca `latest`** nem tag
   móvel (Plano Master §6.2). Tags `candidate-<sha>-<arch>` são só transporte
   imutável do registry; o host fixa apenas digests.
2. As imagens são públicas no GHCR e a VPS as baixa **anonimamente** — não há
   credencial de leitura no host para o registry.
3. **Hardening preservado.** `read_only`, `tmpfs: [/tmp]`, `cap_drop: [ALL]`,
   `no-new-privileges`, segredos em arquivos (`secrets:`), redes internas
   (`backend` internal), limites de CPU/memória/PIDs e label
   `io.stakeframe.deployment` vêm do `x-node` de `compose.production.yml`; não
   editar no host.
4. **Migração é etapa separada** — ver `docs/deploy/migration-runbook.md`,
   nunca junto do `up`.
5. **Sem rollback e sem retry automáticos.** Falha interrompe o procedimento,
   preserva evidências e retorna ao orquestrador (OpenClaude).

## 2. Gates de CI (o que cada workflow faz — e o que não faz)

| Workflow                                  | Disparo                                                      | Faz                                                                                                                                                                                                                    | Não faz                                 |
| ----------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `candidate-images.yml` (Candidate images) | `workflow_dispatch` com `source_sha` da `main` com CI 5/5    | Constrói os cinco targets em amd64+arm64, verifica OCI/proveniência, publica os indexes verificados no GHCR sob tag imutável `candidate-<sha>-<arch>` (recusa mover tag existente para outro digest) e retém evidência | Nenhum deploy, nenhum SSH, sem `latest` |
| `promotion-record.yml` (Promotion record) | `workflow_dispatch` com `candidate_run_id` e `deployment_id` | Pausa no GitHub Environment `production` (required reviewer: proprietário); valida run e evidências; emite `promotion-record.json` com os digests por serviço/arquitetura                                              | Nenhum deploy, nenhum SSH, sem segredos |

Evidências do candidato: artifact `candidate-<sha>-<arch>` (retém 1 dia; tars
OCI + registros) e `candidate-evidence-<sha>-<arch>` (retém 30 dias; candidate,
published e source-validation). O registro aprovado fica em
`promotion-record-<deployment_id>-<run_id>` (90 dias).

## 3. Fluxo de promoção

### 3.0 Decisão (orquestrador)

Autorização específica nomeando: SHA, os digests do `promotion-record.json`
(arquitetura arm64 — alvo da VPS), migrações previstas, evidência de backup,
janela e critério de retorno.

### 3.1 Antes da janela (somente leitura, na VPS)

```bash
cd /opt/stakeframe   # checkout revisado na VPS
node scripts/deployment-check.mjs /etc/stakeframe/deployment.env --integrations --operations
```

- conferir também (gates externos não cobertos pelo checker): espaço livre,
  backup recente e recuperação independente;
- copiar o `deployment.env` vigente para `deployment.previous.env`
  (`root:root 0600`) — origem do retorno (ROLLBACK.md §2);
- guardar o `promotion-record.json` da janela junto da autorização.

### 3.2 Fixar os digests

Editar `/etc/stakeframe/deployment.env` trocando as cinco linhas
`*_IMAGE=ghcr.io/rhianb14/stakeframe-<target>@sha256:…` pelos digests
aprovados (arm64). São referências de nome; os valores vivem apenas nesse
arquivo privado. O preflight do passo 3.4 recusa tag, `latest` ou repositório
fora do prefixo esperado.

### 3.3 Baixar por digest (anônimo)

```bash
docker compose --env-file /etc/stakeframe/deployment.env -f compose.production.yml pull
docker image inspect ghcr.io/rhianb14/stakeframe-api@sha256:<digest> >/dev/null && echo IMAGE_PRESENT
```

Repetir o `inspect` para cada um dos cinco targets. Nada de `pull` sem
`--env-file`, nada de `latest`.

### 3.4 Migrações (se a autorização prever) — etapa separada

Seguir `docs/deploy/migration-runbook.md`, com a autorização própria da
migração. A promoção pausa aqui: sem migração aplicada, não subir os serviços
novos.

### 3.5 Subir os serviços

```bash
docker compose --env-file /etc/stakeframe/deployment.env -f compose.production.yml up -d --wait api worker web
```

Ordem e overlays conforme [DEPLOYMENT.md](../DEPLOYMENT.md) e a autorização
(`--integrations`, `--operations` quando a janela os incluir — validados pelo
`deployment-check` antes). Nunca `down --volumes`, nunca `prune` durante a
janela.

### 3.6 Verificação pós-deploy

```bash
node scripts/deployment-verify.mjs --env-file /etc/stakeframe/deployment.env \
  --endpoint http://127.0.0.1:8080 --expect-version <versão> --expect-commit <sha>
```

Esperado: `DEPLOYMENT_TRACEABILITY_VERIFIED`. Completar a lista:

- [ ] `ps` → todos `healthy`, `restarts=0`;
- [ ] HTTPS com cadeia pública válida no domínio;
- [ ] `/health/live` e `/health/ready` respondem `ok`;
- [ ] `/api/v1/me` recusa requisição anônima;
- [ ] login/logout do proprietário (quando a janela incluir OAuth);
- [ ] logs recentes sem erro novo e alertas/monitor ativos;
- [ ] registro no Kanban ([RELEASE-TRACEABILITY.md](../RELEASE-TRACEABILITY.md) §5.9):
      commit, digests por serviço, horário, resultado e migrações previstas/aplicadas.

## 4. Critérios de aborto e retorno

**Abortar imediatamente** (sem improvisar e sem retry automático) quando:

- um digest fixado não estiver presente ou divergir do `promotion-record`;
- o `deployment-check`/`deployment-verify` acusar qualquer desvio do
  esperado;
- health não ficar saudável dentro dos limites do `--wait`;
- a migração divergir da contagem esperada (guard em
  `migration-runbook.md` §2);
- qualquer passo precisar de algo fora da autorização.

Em caso de aborto: **parar**, preservar evidências (`ps`, logs, saída dos
checkers) e devolver ao orquestrador. O retorno é o procedimento de rollback de
aplicação ([ROLLBACK.md](../ROLLBACK.md)): copiar os digests anteriores de
`deployment.previous.env`, rodar o planejador read-only
(`rollback-plan.mjs --check`), cumprir o guard de migrações e executar apenas
com autorização própria. Migração não se reverte por imagem; restauração de
banco exige backup verificado e janela própria ([RECOVERY.md](../RECOVERY.md)).

## 5. Proibições

- `latest` ou qualquer tag móvel em produção; deploy sem digest fixado;
- SSH, chaves ou segredos de produção em repositório, workflow, card ou log —
  nos workflows existem apenas referências de nome (`GITHUB_TOKEN` embutido,
  inputs e nomes de variáveis do arquivo privado);
- `curl | sudo bash` e afins (não usados em nenhum passo);
- rollback, migração ou restauração sem autorização específica;
- remover volumes, `down --volumes`, `prune` durante a janela, trocar senhas
  ou inicializar outro cluster como reação a falha.

## 6. Referências

- [DEPLOYMENT.md](../DEPLOYMENT.md) — comandos-base e conferências da instalação;
- [ROLLBACK.md](../ROLLBACK.md) — plano e execução do retorno;
- [migration-runbook.md](migration-runbook.md) — etapa de migração;
- [RELEASE-TRACEABILITY.md](../RELEASE-TRACEABILITY.md) §5 — registro no Kanban;
- `compose.production.yml` — hardening e pins; `compose.migration.yml` — migração;
- `.github/workflows/candidate-images.yml` e `.github/workflows/promotion-record.yml`.
