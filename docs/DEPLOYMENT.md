# Implantação

> **STATUS: PILOTO ARM64 IMPLANTADO; HTTPS PÚBLICO PENDENTE.** A execução
> autorizada de 07/09/2026 está registrada em
> [M0-24-VALIDATION.md](M0-24-VALIDATION.md). O DNS ainda aponta para um
> endereço externo à VPS, portanto a emissão ACME não pode ser concluída.

## Alvo (planejado)

- Hospedagem na VPS Oracle Always Free, com Docker Compose.
- Serviços: aplicação web, API, worker, PostgreSQL 18 e Caddy (proxy HTTPS),
  em rede interna; apenas Caddy exposto publicamente. O worker usará a API
  Gemini 3.8 Flash via OpenRouter, conforme [AI-MODEL-SELECTION.md](AI-MODEL-SELECTION.md).
- Imagens construídas pela CI e referenciadas por versão/digest.
- Domínio `stakeframe.com.br`; a aplicação está na VPS ARM64
  `129.146.113.111`. O registro observado durante o piloto aponta para
  `162.240.81.81` e precisa ser corrigido antes da validação HTTPS pública.

## Preparação do artefato

O workflow e os critérios de conferência estão em
[RELEASE-CANDIDATE.md](RELEASE-CANDIDATE.md). O registro dos gates e a sequência
da primeira janela estão em [FIRST-DEPLOYMENT.md](FIRST-DEPLOYMENT.md).

1. Selecionar um commit da `main` com CI aprovada em AMD64/ARM64. Construir e
   publicar os targets `api`, `worker`, `migrate`, `web-production` e `operations`
   em tarefa própria; registrar os cinco digests e a proveniência do build.
2. Preparar o arquivo de configuração privado a partir de
   [deployment.env.example](../infra/production/deployment.env.example),
   incluindo os digests exatos. Guardar a configuração anterior.
3. Provisionar segredos externos conforme [PRODUCTION-CONFIGURATION.md](PRODUCTION-CONFIGURATION.md),
   com acesso mínimo. O cliente Google e o callback de produção
   `https://stakeframe.com.br/api/auth/callback/google` foram preparados na
   [STK-M0-14](M0-14-VALIDATION.md); a instalação do segredo na VPS e o login
   real continuam pendentes.
4. Executar `node scripts/deployment-check.mjs /caminho/privado/deployment.env --integrations --operations`.
   Conferir DNS, firewall, acesso administrativo independente, espaço livre,
   backups e recuperação. O checker não comprova esses gates externos.
5. Registrar autorização explícita do Codex com commit, digests, ambiente,
   migrações previstas, evidência de backup e estratégia de reversão.

## Operação executada no piloto ARM64

O piloto usou a configuração privada em `/etc/stakeframe/deployment.env`, os
três arquivos Compose (produção, integrações e operações) e o perfil
`operations`. Os cinco digests aprovados foram baixados, os serviços foram
recriados e a migração foi executada explicitamente. O procedimento e os
resultados estão em [M0-24-VALIDATION.md](M0-24-VALIDATION.md).

## Operação futura, somente após autorização

Executar no checkout revisado da VPS, com arquivo de configuração privado.
Os comandos abaixo são o procedimento preparado para a base; não foram executados
na VPS. Para o piloto completo, acrescentar os overlays e o perfil descritos em
[OPERATIONS.md](OPERATIONS.md), inicializar o backup e ativar operações somente
dentro da autorização que inclua retenção, integrações e agendamento.

```bash
docker compose --env-file /etc/stakeframe/deployment.env -f compose.production.yml pull
docker compose --env-file /etc/stakeframe/deployment.env -f compose.production.yml up -d --wait postgres
docker compose --env-file /etc/stakeframe/deployment.env -f compose.production.yml --profile migration run --rm -e MIGRATION_CONFIRM=production migrate
docker compose --env-file /etc/stakeframe/deployment.env -f compose.production.yml up -d --wait api worker web
```

Antes de migrar um banco existente, verificar o backup recuperável autorizado.
No primeiro banco vazio, registrar explicitamente essa condição e preservar
os segredos de recuperação fora da VPS. O perfil `migration` impede migrações
automáticas no startup normal. `MIGRATION_CONFIRM=production` confirma intenção
do operador; não é prova de autorização nem de backup. A execução usa o lock
advisory e os limites de tempo já existentes no migrador.

Conferir HTTPS com cadeia pública válida, `/health/live`, `/health/ready`,
recusa anônima em `/api/v1/me`, login/recarga/logout do proprietário e ausência
de portas públicas de banco/API/worker. Conferir também alertas e backup.
Registrar commit, digests, horário, resultados e autorização no relatório.

## Reversão preparada

- Guardar os digests anteriores e a configuração antes de atualizar. Em falha
  da aplicação, reapontar para esses digests e subir os serviços com `--wait`.
- Não executar migração reversa automática. Conferir a compatibilidade do
  schema com a versão anterior; restauração de banco exige autorização,
  backup verificado e janela própria, seguindo [RECOVERY.md](RECOVERY.md).
- Não remover volumes, executar `down --volumes`, trocar senhas nem inicializar
  outro cluster como reação automática a uma falha de startup.

## Requisitos que bloqueiam o primeiro deploy

- [x] VPS existente inventariada e acesso administrativo testado; revalidar
      acesso e recuperação independente antes da futura janela.
- [x] Domínio adquirido, conforme informação do proprietário.
- [ ] DNS e HTTPS configurados e verificados; o DNS atual aponta para
      `162.240.81.81`, não para a VPS `129.146.113.111`.
- [x] Imagens publicadas por digest e artefato de release revisado; publicação
      #10 e execução ARM64 estão registradas em `M0-24-VALIDATION.md`.
- [ ] Backup externo funcionando e restauração testada.
- [ ] Segredos de produção configurados fora do repositório.
- [ ] OAuth de produção e procedimento de reversão validados.
- [ ] Autorização expressa do Codex.

O ensaio local comprova somente o cenário descrito em
[PRODUCTION-CONFIGURATION.md](PRODUCTION-CONFIGURATION.md). A primeira execução
na VPS será tratada como piloto, com autorização e registro próprios. A integração
contínua com OpenRouter, Telegram e R2 está preparada no overlay de integrações,
com backup, retenção e monitor em [OPERATIONS.md](OPERATIONS.md). A instalação
do OmniRoute na VPS foi dispensada pela decisão D017.
