# Implantação

> **STATUS: PRODUÇÃO NÃO IMPLANTADA.** A configuração de produção e o ensaio
> isolado estão descritos em [PRODUCTION-CONFIGURATION.md](PRODUCTION-CONFIGURATION.md).
> Publicação de imagens, DNS/ACME e operação na VPS permanecem pendentes.

## Alvo (planejado)

- Hospedagem na VPS Oracle Always Free, com Docker Compose.
- Serviços: aplicação web, API, worker, PostgreSQL 18, Caddy (proxy HTTPS) e
  OmniRoute (IA), em rede interna; apenas Caddy exposto publicamente.
- Imagens construídas pela CI e referenciadas por versão/digest.
- Domínio `stakeframe.com.br` (compra informada pelo proprietário em
  06/09/2026); DNS e HTTPS automático via Caddy ainda pendentes.

## Preparação do artefato

1. Selecionar um commit da `main` com CI aprovada em AMD64/ARM64. Construir e
   publicar os targets `api`, `worker`, `migrate` e `web-production` em tarefa
   própria; registrar os quatro digests e a proveniência do build.
2. Preparar o arquivo de configuração privado a partir de
   [deployment.env.example](../infra/production/deployment.env.example),
   incluindo os digests exatos. Guardar a configuração anterior.
3. Provisionar segredos externos conforme [PRODUCTION-CONFIGURATION.md](PRODUCTION-CONFIGURATION.md),
   com acesso mínimo. Configurar o callback Google de produção exatamente em
   `https://stakeframe.com.br/api/auth/callback/google`.
4. Executar `node scripts/deployment-check.mjs /caminho/privado/deployment.env`.
   Conferir DNS, firewall, acesso administrativo independente, espaço livre,
   backups e recuperação. O checker não comprova esses gates externos.
5. Registrar autorização explícita do Codex com commit, digests, ambiente,
   migrações previstas, evidência de backup e estratégia de reversão.

## Operação futura, somente após autorização

Executar no checkout revisado da VPS, com arquivo de configuração privado.
Os comandos abaixo são o procedimento preparado; não foram executados na VPS.

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
- [ ] DNS e HTTPS configurados e verificados.
- [ ] Imagens publicadas por digest e artefato de release revisado.
- [ ] Backup externo funcionando e restauração testada.
- [ ] Segredos de produção configurados fora do repositório.
- [ ] OAuth de produção e procedimento de reversão validados.
- [ ] Autorização expressa do Codex.

O ensaio local comprova somente o cenário descrito em
[PRODUCTION-CONFIGURATION.md](PRODUCTION-CONFIGURATION.md). A primeira execução
na VPS será tratada como piloto, com autorização e registro próprios. OmniRoute,
Telegram e R2 ainda não fazem parte deste Compose.
