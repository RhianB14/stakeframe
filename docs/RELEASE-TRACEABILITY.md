# Stakeframe — versionamento e rastreabilidade de releases

Este documento define como cada versão do beta fechado do Stakeframe é identificada e
rastreada entre commit, tag, release, imagem, digest, aplicação em execução e registros
operacionais. Nada aqui autoriza release, deploy ou migração: as autorizações continuam
sendo emitidas por tarefa, conforme `AGENTS.md`.

## 1. Versionamento SemVer

- O beta fechado segue SemVer com sufixo de pré-lançamento: `v0.1.0-beta.1` é a primeira
  versão do beta (`MAJOR.MINOR.PATCH` com `-beta.N`).
- **Fonte única de verdade**: o campo `version` do `package.json` da raiz do repositório.
  Nenhum outro arquivo, painel ou pipeline mantém uma segunda cópia da versão.
- A tag Git anotada de uma release é `v` + a versão (ex.: `v0.1.0-beta.1`).
  A tag final só é criada com autorização explícita (ver §6).

## 2. Metadados estampados no artefato

O build copia a fonte única e os dados do próprio build para dentro da imagem:

| Variável (runtime)      | Origem                                        | Valor quando ausente |
| ----------------------- | --------------------------------------------- | -------------------- |
| `STAKEFRAME_VERSION`    | `version` do `package.json` (build arg)       | `unversioned`        |
| `STAKEFRAME_COMMIT`     | SHA de 40 hex do commit da `main` (build arg) | `unknown`            |
| `STAKEFRAME_BUILD_DATE` | data UTC do build `AAAA-MM-DDTHH:MM:SSZ`      | `unknown`            |
| `STAKEFRAME_RUNTIME`    | ambiente do Compose (`local` / `production`)  | `unknown`            |

- O `Dockerfile` declara os três primeiros como `ARG` → `ENV` nos estágios `runtime`
  (api/worker/migrate), `operations` e `web`, e aplica os labels OCI
  `org.opencontainers.image.{title,description,source,revision,version,created}`.
- O workflow `release-candidate.yml` lê a versão do commit revisado, valida o formato
  SemVer, carimba uma data única para os cinco artefatos da rodada e passa tudo como
  build args.
- Valores nunca são inventados: artefatos sem estampilha carregam os marcadores acima e
  são recusados pela verificação (ver §4).

## 3. Contrato do endpoint operacional

`GET /api/v1/system/status` (público técnico, sem alteração de estado) agora inclui:

```json
{
  "name": "Stakeframe",
  "stage": "local-setup",
  "database": "available",
  "authentication": "google",
  "productEnabled": true,
  "release": {
    "version": "0.1.0-beta.1",
    "commit": "274944f53f1fc418198bd256049644a38417ac24",
    "builtAt": "2026-09-14T12:00:00Z",
    "environment": "production"
  }
}
```

- `version`: SemVer da release ou `unversioned`; `commit`: 40 hex (ou ≥7) ou `unknown`;
  `builtAt`: instante UTC ou `unknown`; `environment`: `local`, `production` ou `unknown`.
- A resposta é sanitizada: nenhum valor de variável de ambiente, caminho, segredo,
  cabeçalho ou detalhe interno é exposto — apenas os quatro campos acima.
- O painel do proprietário (`ProductApp`) e o rodapé público exibem `v<version>` quando
  a versão está estampada e **não exibem nada** quando o valor é `unversioned`
  (metadados ausentes são tratados de forma segura, sem dados inventados).
- O contrato é validado por `releaseInfoSchema` (pacote `@stakeframe/shared`) e coberto
  por testes unitários, de API e de interface.

## 4. Imagens, digest e rastreabilidade

- Imagens são publicadas em `ghcr.io/rhianb14/stakeframe-<alvo>` e **consumidas sempre por
  digest** (`repo@sha256:...`); o Compose de produção recebe os digests por
  `/etc/stakeframe/deployment.env`. O serviço `web` do Compose usa a imagem do alvo
  publicado (`stakeframe-web-production`, fiel ao target do `Dockerfile`); o verificador
  de rastreabilidade e o planejador de rollback validam exatamente o nome publicado para
  cada serviço (o `WEB_IMAGE` esperado é `…-web-production@sha256:…`).
- `latest` é proibido como identificador operacional (plano canônico, §vetos) e é
  recusado pelos scripts desta unidade.
- `scripts/release/verify_oci.py` recusa artefatos sem os labels obrigatórios:
  `OCI_REVISION_MISMATCH` (source/revision), `OCI_VERSION_REQUIRED`
  (`org.opencontainers.image.version` SemVer) e `OCI_CREATED_REQUIRED` (data UTC RFC3339).
  O `*.verified.json` resultante registra `releaseVersion` e `releaseCreated` por alvo.
- A tag transitória de candidato (`candidate-<sha>-<arch>`) nunca é referência de
  produção; o vínculo operacional é `digest ↔ sourceSha ↔ releaseVersion`.

## 5. Fluxo de release (preparado; execução exige autorização)

1. escolher um commit exato da `main` com CI 5/5 verde;
2. criar a tag Git anotada `v<versão>` apontando para esse commit (autorização);
3. criar o GitHub Release a partir da tag, com notas e o SHA de origem (autorização);
4. executar `release-candidate.yml` com `source_sha` = commit da tag (build estampado);
5. verificar os cinco artefatos e fixar os digests no registro aprovado
   (`infra/release/approved-<arch>.json`, uma PR de um arquivo);
6. publicar os digests aprovados (`publish-candidate.yml`);
7. deploy: trocar as linhas de digest em `deployment.env` e subir com
   `up -d --no-deps` por serviço (autorização específica);
8. validar com `scripts/deployment-verify.mjs` (§6) — falha = rollback/reversão;
9. registrar no card do Kanban: versão, tag, commit, digest por serviço, imagem,
   ambiente, migrações previstas/aplicadas, data, responsável e resultado da validação.

Enquanto a etapa 6 não ocorrer, nenhum push de imagem é considerado publicado; enquanto a
etapa 7 não ocorrer, nenhum environment é considerado deployado.

## 6. Validação pós-deploy (obrigatória antes de declarar sucesso)

```bash
node scripts/deployment-verify.mjs \
  --env-file /etc/stakeframe/deployment.env \
  --endpoint http://127.0.0.1:<porta-publicada> \
  --expect-version 0.1.0-beta.1 --expect-commit <sha40 com CI verde>
```

O script compara: pins do `deployment.env` (somente digest, repositório exato), a imagem
em execução de cada serviço, os labels `version`/`revision` das imagens e a resposta
`release` do endpoint. Qualquer divergência — inclusive metadados ausentes — encerra com
`DEPLOYMENT_TRACEABILITY_REFUSED <códigos>` e código de saída 1; o sucesso imprime
`DEPLOYMENT_TRACEABILITY_VERIFIED` e os digests observados (truncados). O script é
somente leitura (não altera estado) e nunca imprime valores de ambiente além dos digests.

**Conjunto obrigatório (fail-closed):** o `deployment.env` deve fixar **exatamente os
cinco serviços** (`api`, `worker`, `migrate`, `web`, `operations`). No modo padrão o
verificador recusa qualquer conjunto incompleto (`PINS_INCOMPLETE … missing=…`) e
qualquer chave `*_IMAGE` duplicada (`PIN_DUPLICATE_KEY`) — nunca há aceitação silenciosa
do "último valor". A inspeção dos containers não pode ser omitida no modo padrão
(`SKIP_DOCKER_REQUIRES_SERVICES`). O modo **parcial** existe somente de forma explícita
via `--services api,worker,…`: os serviços são declarados pelo operador, validados um a
um, e a saída é marcada `mode=explicit services=N` — uma execução parcial nunca se
confunde com a verificação completa (`mode=full services=5`). O modo parcial destina-se a
ensaios locais/rehearsal, nunca à validação de produção.

## 7. Estado da produção na auditoria de 2026-09-14 (somente leitura)

- containers `stakeframe-production-*`: api, worker, migrate (imagem usada pelo perfil de
  migração), web e operations — saudáveis; subida em **2026-09-13T13:30Z** (UTC).
- digests em execução correspondem ao registro aprovado **STK-M0-64**
  (`sourceSha 1a8eab4db54a331336baa9582e39814940ce0096`, PR #116).
- o checkout da VPS (`/opt/stakeframe`) registra a revisão `36c0e6386f…` (STK-M0-28,
  2026-09-09) — os arquivos da aplicação não são um repositório Git; a implantação de
  arquivos é feita por sincronização e a de imagens por digest.
- migrações aplicadas: 5 (todas as existentes até 0004, em 2026-09-07); as migrações
  `0005`–`0007` (F1) **não** foram aplicadas em produção.
- não havia mecanismo formal de rollback documentado; esta unidade o define
  (`docs/ROLLBACK.md`) e fornece o planejador `scripts/deployment/rollback-plan.mjs`.

## 8. Proibições

- usar `latest` como identificador único; deploy sem digest; release/tag sem autorização;
  migração automática no deploy; segredos em qualquer artefato, log ou registro.
