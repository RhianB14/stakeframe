# Implantação

> **STATUS: NÃO IMPLEMENTADO.** Nenhum procedimento abaixo foi executado ou
> validado. Este documento descreve o que será construído no M0. Não tratar
> nada daqui como operação disponível.

## Alvo (planejado)

- Hospedagem na VPS Oracle Always Free, com Docker Compose.
- Serviços: aplicação web, API, worker, PostgreSQL 18, Caddy (proxy HTTPS) e
  OmniRoute (IA), em rede interna; apenas Caddy exposto publicamente.
- Imagens construídas pela CI e referenciadas por versão/digest.
- Domínio `stakeframe.com.br` (aquisição pendente) + DNS + HTTPS automático
  via Caddy.

## Procedimento de deploy (a implementar)

1. Build das imagens na CI a partir de um commit da `main`.
2. Autorização específica do Codex para deploy (pode agrupar release).
3. Aplicação do compose com a versão exata das imagens.
4. Migrações de banco, quando houver — sempre após backup validado.
5. Verificação pós-deploy (healthchecks e smoke tests documentados).
6. Registro do deploy (versão, digest, data, autorização).

## Rollback (a implementar)

- Reapontar para a imagem anterior (digest conhecido) e revalidar.
- Migrações de banco devem ser aditivas/reversíveis; reversão documentada por
  migração.

## Requisitos que bloqueiam o primeiro deploy

- [ ] VPS provisionada e acessível (acesso restrito documentado).
- [ ] Domínio adquirido e DNS configurado.
- [ ] Backup externo funcionando e restauração testada.
- [ ] Segredos de produção configurados fora do repositório.
- [ ] Autorização expressa do Codex.

Nenhuma etapa deste documento foi testada. A primeira execução real será
tratada como piloto, com autorização e registro próprios.
