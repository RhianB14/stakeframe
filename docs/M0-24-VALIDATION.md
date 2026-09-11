# STK-M0-24 — Piloto de produção ARM64

Data: 2026-09-07. Execução e verificação pelo Codex, conforme a autorização
de implantação e migração do proprietário.

## Artefato e publicação

- Commit de origem das imagens: `317ec2681dca06718db7ffdd8261d9d3ed9a6c3c`.
- Publicação aprovada: [workflow #10](https://github.com/RhianB14/stakeframe/actions/runs/34154325519), concluída com sucesso.
- VPS: Oracle ARM64 em `129.146.113.111`.
- Migração: `MIGRATIONS_COMPLETE`.

Digests instalados no arquivo privado `/etc/stakeframe/deployment.env`:

| Serviço   | Digest                                                             |
| --------- | ------------------------------------------------------------------ |
| API       | `da62896345ae27a75083d3ce032c42e3e131c4ddb308a6377baef7da099d2116` |
| Worker    | `cbe6b61a5c5d5fba80ce00700614cdb67af9a9f98d34e77698ebdfc1512f07a2` |
| Migração  | `ebc70080180a9fe585b7a96e2fd431c094d4b8426492f5e547c55bbee7dac60d` |
| Web       | `066ee861c447538ffe852290a8fc98edeeb61e3e82990f1dde6f48bb4f3bc0a7` |
| Operações | `8f9e5f34e74e59bdc95063def2e813ed65dab002cab3037df00075ec8abc6526` |

## Verificações

- PostgreSQL, API, worker, operações e web ficaram `healthy` no Compose.
- Os logs de operações registraram `OPS_SCHEDULER_READY` e
  `OPS_BACKUP_VERIFIED`.
- HTTP local respondeu `308`, confirmando o redirecionamento para HTTPS.
- Após a correção DNS, o Caddy obteve com sucesso o certificado ACME para
  `stakeframe.com.br` (ordem Let's Encrypt concluída).
- A validação pública com o IP da VPS respondeu `200` na página inicial,
  `{"status":"alive"}` em `/health/live`, `{"status":"ready"}` em
  `/health/ready` e `401` na rota protegida de operações, como esperado para
  acesso anônimo.
- O status público confirmou `database: available`, `authentication: google`
  e `productEnabled: true`; `/api/v1/me` respondeu `401 UNAUTHENTICATED` sem
  cookie de sessão.
- O início do OAuth respondeu `200`, criou o cookie de estado seguro e gerou
  uma URL no host `accounts.google.com` com callback HTTPS para o domínio.
  Um callback sem estado foi recusado com redirecionamento controlado para
  `/?auth=failed&error=state_not_found`. **Limite da evidência:** o início do
  fluxo, o callback seguro e a recusa sem sessão foram verificados; o login
  real do proprietário ainda não foi executado, portanto o OAuth end-to-end
  permanece pendente.

## Limitação externa

O registro A da zona HostGator foi alterado de `162.240.81.81` para
`129.146.113.111`. As consultas DNS over HTTPS do Cloudflare e do Google já
retornam o novo endereço; alguns resolvedores locais podem manter o valor
anterior até o vencimento do TTL. O certificado HTTPS e os probes públicos
foram revalidados após a propagação.

O piloto não altera a autorização para produção contínua, retenção externa de
backups, ativação do Telegram ou instalação de credenciais R2.

**Divergência operacional (registrada em 08/09/2026):** apesar de a retenção
externa de backups e a instalação de credenciais R2 estarem explicitamente
fora do escopo registrado acima, o repositório Restic no R2, a retenção e o
daemon de backup foram ativados nesta mesma janela. A divergência foi
descoberta em 08/09/2026; cronologia e evidência em
[M0-25-VALIDATION.md](M0-25-VALIDATION.md).

**Segunda divergência operacional (registrada em 11/09/2026):** o
levantamento somente leitura da STK-M0-40 encontrou o consumidor Telegram
contínuo **ativo** em produção: o worker foi criado nesta janela (07/09/2026
19:09 UTC) com o overlay `compose.integrations.yml` em uso — `TELEGRAM_ENABLED=true`,
`AI_ENABLED=true` e segredos de Telegram/OpenRouter/R2 montados desde a
criação — apesar de a autorização acima excluir expressamente a ativação do
Telegram e a operação contínua das integrações. O comando exato da janela que
produziu essa configuração não pôde ser recuperado; **não há evidência para
atribuir a ativação ao Hermes**. Na descoberta, o consumidor seguia ativo
(advisory lock retido, cursor avançado), sem itens persistidos e sem chamadas
de IA registradas; contenção reversível e reativação autorizada permanecem
pendentes de decisão. Evidência, matriz e planos em
[M0-40-TELEGRAM-PRODUCTION-PREFLIGHT.md](M0-40-TELEGRAM-PRODUCTION-PREFLIGHT.md).
Esta reconciliação não transforma retroativamente a ativação em ação
previamente autorizada.

## Pendência operacional

As verificações somente leitura encontraram todos os cinco containers saudáveis
e `OPS_BACKUP_VERIFIED` nos logs; nada foi alterado nesta execução.

Reconciliação posterior (08/09/2026): a ativação do daemon de backup ocorreu na
mesma janela — primeiro `OPS_SCHEDULER_READY` às 19:09:55 UTC e primeiro
`OPS_BACKUP_VERIFIED` às 19:10:20 UTC de 07/09 — fora do escopo registrado
para esta execução. O comando exato de ativação não pôde ser recuperado; o
próprio registro M0-24 atribui a execução da janela ao Codex, e não há
evidência para atribuir a ativação ao Hermes. Após a descoberta, o Codex
autorizou explicitamente manter o daemon em execução durante as janelas
STK-M0-25A/25B, para não reduzir a proteção existente; as permissões do
diretório de segredos e a duplicação de segredos foram corrigidas
separadamente em 25A/25B. Esta reconciliação não transforma retroativamente a
ativação inicial em ação previamente autorizada. Evidência integral em
[M0-25-VALIDATION.md](M0-25-VALIDATION.md).
