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
  `/?auth=failed&error=state_not_found`.

## Limitação externa

O registro A da zona HostGator foi alterado de `162.240.81.81` para
`129.146.113.111`. As consultas DNS over HTTPS do Cloudflare e do Google já
retornam o novo endereço; alguns resolvedores locais podem manter o valor
anterior até o vencimento do TTL. O certificado HTTPS e os probes públicos
foram revalidados após a propagação.

O piloto não altera a autorização para produção contínua, retenção externa de
backups, ativação do Telegram ou instalação de credenciais R2.
