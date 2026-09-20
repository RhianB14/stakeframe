# Policy da importação automática — preparação e operação

Este documento descreve como a policy privada da importação automática é
preparada, validada e operada. Ele **não ativa nada**: a ativação exige janela
autorizada própria, e até lá `AUTOMATIC_IMPORT_ENABLED=false` mantém toda
importação em revisão manual.

## Decisão de produto que a policy carrega

- A casa vem do usuário (legenda do Telegram, MiniApp ou Web); a IA **nunca**
  identifica, infere ou escolhe bookmaker, e a resposta com casa/layout é
  rejeitada (`AI_EXTRACTION_INVALID`).
- A IA apenas organiza os dados recebidos do OCR; data e hora do evento ficam
  fora da extração inicial; `potentialReturn` só é transcrito com rótulo +
  valor explícitos no OCR — nunca calculado por stake × odd.
- Qualquer incerteza (referência ambígua, OCR inconsistente, casa fora da
  lista aprovada) resulta em revisão manual.

## Contrato (schemaVersion 3)

Arquivo JSON validado por `automaticPolicyV3Schema` (`packages/shared/src/automatic-policy.ts`):

| Campo                                    | Regra                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                          | `3` — a v2 global (todas as casas ativas) é recusada por não conseguir representar casa pendente                              |
| `requiresUserBookmaker`                  | `true`                                                                                                                        |
| `aiBookmakerClassification`              | `disabled`                                                                                                                    |
| `bookmakerScope`                         | `explicit`                                                                                                                    |
| `bookmakers.approved`                    | ≥1 slug de casa homologada (`bet365`/`superbet`/`novibet`), sem repetição                                                     |
| `bookmakers.pending`                     | casas retidas com `reason` obrigatório (1–240 chars); não podem colidir com `approved`                                        |
| `model`                                  | modelo exato da cadeia OpenRouter aprovado na evidência                                                                       |
| `placedAtFormats`                        | formatos aceitos para a data de envio (a evidência precisa estar coberta)                                                     |
| `allowFreebet` / `potentialReturnLabels` | rótulos de retorno cobertos pela evidência                                                                                    |
| `corpusSha256` / `evaluationSha256`      | agregado das evidências **aprovadas** (nunca inclui pendente)                                                                 |
| `coverage` / `sampleCount`               | agregado das evidências aprovadas; mínimos do schema (20 positivas, 5 negativas, 3 múltiplas, 3 ausências, 20 imagens únicas) |
| `essentialFieldErrors`                   | `0` — nunca preenchido artificialmente; o checker recalcula                                                                   |
| `approvedBy`                             | `owner` — aprovação explícita do proprietário                                                                                 |
| `approvedAt` / `expiresAt`               | janela de validade ISO com offset; expirada ⇒ estado `invalid` ⇒ revisão                                                      |

**Semântica de casas**: apenas casas em `approved` seguem para o caminho
automático; casa `pending` (ou ausente das listas) permanece em revisão manual
com motivo sanitizado (`BOOKMAKER_NOT_APPROVED`). O runtime mapeia a casa
resolvida do catálogo ativo para o slug (`Bet365` → `bet365`); nome não
reconhecido = não aprovada.

## Evidência atual (retrato da preparação)

| Casa     | Evidência real                                                                 | Resultado                             | Status na candidata              |
| -------- | ------------------------------------------------------------------------------ | ------------------------------------- | -------------------------------- |
| Bet365   | Rodada real completa (25/25, 0 erros essenciais, cobertura completa, elegível) | elegível para revisão do proprietário | **aprovada**                     |
| Superbet | Rodada real 19/25 com 7 erros essenciais                                       | não elegível                          | **pendente** (motivo no arquivo) |

- Projeção local da Superbet (21/25) e rodada direcionada (4/4 positivos +
  5/5 controles) são análises/reprocessamentos **parciais** — não constituem
  homologação completa e **não** autorizam aprovação.
- A candidata versionada em `infra/production/automatic-import.candidate.json`
  (sha256 `89a85a8c…`) foi validada offline com `verifyApprovalPolicy` contra a
  evidência da Bet365: `ok:true`, `verified=[bet365]`, `pending=[superbet]`.
  A validação roda sobre a cópia privada fora do repositório (o checker recusa
  caminhos dentro do workspace).

## Arquivos e caminhos

- **Produção (VPS)**: `/etc/stakeframe/automatic-import.json` — arquivo
  privado, caminho absoluto, **modo `0600`** (grupo/outros sem nenhum acesso;
  qualquer bit de grupo/outro ⇒ estado `invalid`). Owner: o usuário
  administrativo que opera o deploy (o mesmo que roda `deployment-check` e
  `docker compose`); conferir com `stat -c '%U %a'` antes da janela.
- **Variável**: `AUTOMATIC_IMPORT_POLICIES_FILE=/etc/stakeframe/automatic-import.json`
  no `deployment.env` (exemplo em `infra/production/deployment.env.example`).
- **Overlay**: `compose.automatic-import.yml` monta o arquivo read-only em
  `/run/policies/automatic-import.json` e liga `AUTOMATIC_IMPORT_ENABLED=true`
  **somente** quando o overlay é usado. Sem o overlay, o worker roda com
  `AUTOMATIC_IMPORT_ENABLED=false`.
- O loader do worker é fail-closed: arquivo ausente, ilegível, >32 KiB,
  symlink, modo aberto, JSON inválido, schema recusado (v1/v2), ou janela
  expirada ⇒ `invalid`/`absent` ⇒ tudo em revisão. `null` nunca autoriza.

## Procedimento de validação (offline, antes da janela)

1. Gerar/atualizar a candidata com a evidência salva (sem chamadas externas):
   `node scripts/validation/policy.mjs <candidata-privada> <dir-corpus-aprovado…>`
   — o checker recalcula a avaliação, confere tamper/hashes/cobertura/
   contagens/elegibilidade/validade e a declaração de casas
   (`POLICY_BOOKMAKER_UNDECLARED`, `POLICY_APPROVED_EVIDENCE_MISSING`,
   `POLICY_NOT_ELIGIBLE`, `POLICY_EXPIRED`, …). Nada é escrito.
2. Conferir que a evidência citada é **real** (evaluation.json salvo) — uma
   projeção local não tem avaliação salva e é recusada (`CORPUS_DIRECTORY_INVALID`).
3. Copiar a candidata validada para o caminho privado da VPS e conferir
   `stat -c '%U %a'` = owner do operador e `600`; `sha256sum` igual ao
   registrado.
4. Rodar o deployment-check **com** o overlay e a variável:
   `node scripts/deployment-check.mjs <deployment.env> --integrations --automatic`
   — valida a renderização do compose (mount read-only, caminho) e a
   legibilidade/tamanho do arquivo. Sem `DEPLOYMENT_CONFIGURATION_VERIFIED`
   não seguir.
5. Registrar a autorização da janela (commit, sha256 da policy, evidência,
   estratégia de reversão) — a ativação é uma decisão separada do proprietário
   com o Codex.

## Ativação (somente em janela autorizada)

1. Com o arquivo instalado e validado, subir o worker com o overlay:
   `docker compose --env-file /etc/stakeframe/deployment.env -f compose.production.yml -f compose.automatic-import.yml up -d --wait worker`.
2. Conferir o estado no MiniApp/web (aviso sanitizado) e nos logs do worker;
   confirmar que casas pendentes seguem em revisão.
3. Nenhum segredo, imagem de bilhete ou conteúdo privado entra em commit, PR,
   card ou log — apenas totais, contagens e hashes.

## Rollback da policy

1. `docker compose --env-file /etc/stakeframe/deployment.env -f compose.production.yml up -d --wait worker`
   (sem o overlay) ⇒ `AUTOMATIC_IMPORT_ENABLED=false`; toda importação volta a
   revisão imediatamente, sem tocar dados já importados.
2. Se preferível manter o overlay e invalidar só a policy: mover/renomear o
   arquivo (ou reduzir a janela) — o loader passa a `absent`/`invalid`.
3. A reversão é sempre de **elegibilidade**, nunca financeira: apostas já
   importadas permanecem canônicas.

## Expiração e renovação

- `expiresAt` é obrigatório e o loader recusa a policy após o instante — a
  automação desliga sozinha (fail-closed) até nova aprovação.
- Renovação = repetir o procedimento de validação com evidência atual e nova
  janela (`approvedAt`/`expiresAt` novos); a evidência de casas pendentes não
  muda o status sem homologação completa.
- A renovação não é automática: exige aprovação explícita do proprietário
  (`approvedBy: "owner"`).

## O que esta preparação NÃO fez

- Não criou nem alterou `/etc/stakeframe/automatic-import.json` na VPS.
- Não ligou `AUTOMATIC_IMPORT_ENABLED`, não fez deploy, migração, release ou
  chamadas externas.
- Não promoveu a Superbet: a casa segue pendente até homologação real completa.
