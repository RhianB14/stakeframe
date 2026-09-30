# STATUS — onde o projeto está agora

> Documento **mutável**. É reescrito a cada marco relevante. Para o objetivo
> do produto, ver [PROJECT.md](PROJECT.md); para as regras de operação,
> [AGENTS.md](AGENTS.md); para as decisões, [docs/DECISIONS.md](docs/DECISIONS.md).

Última atualização: **2026-09-29**

## Fonte de verdade

- **Cards:** kanban `stakeframe` (SQLite local do Hermes). É o placar real.
- **`main`:** `27494ec` (PR #239 Polymarket ingest; antes #238 docs, #237 relatórios).
- **Migrações aplicadas no `main`:** 29 entradas, última
  `0028_polymarket_ingest`. Nada disso está em produção.

## Placar

| Fase      | Progresso                                     | Observação                             |
| --------- | --------------------------------------------- | -------------------------------------- |
| Gate 0    | G0-01, 03, 04 done · G0-02 em curso (dia 4/7) | G0-05/06/07 exigem autorização do dono |
| Fase 1    | 13/13 done                                    | fechada; define o baseline operacional |
| Fase 2    | 14/18 done                                    | em andamento                           |
| Fases 3–5 | não iniciadas                                 | dependem de gate e decisão de produto  |

## Em andamento

- **STK-F2-15** — Polymarket: ranking oficial top 100 + filtros + truncamento
  visível. Delegada ao Hermes (branch `stk/f2-15-polymarket-ranking`, migração
  reservada conforme journal). Depende da F2-14, recém-merged.

## Concluído na Fase 2

F2-02 dashboard · F2-03 splits · F2-04 vínculo Telegram · F2-05 fluxo de
bilhete · F2-06 OCR fail-closed + cota · F2-07 comandos Telegram ·
F2-08 relatórios privados + snapshot · F2-09 importação CSV · F2-10 freebets ·
F2-11 painel superadmin · F2-12 Mini App · F2-13 entitlements + circuit
breakers (teto R$200/mês) · F2-14 Polymarket ingestão (dedup determinística,
backfill 180d, completude nunca inferida).

## Fila restante

1. **F2-16** — favoritos + alertas (worker/API). Paralela, em `stk/f2-16-polymarket-favoritos`
2. **F2-18** — gate de ativação do Polymarket. **Exige autorização específica
   do proprietário** (flag + breakers + Fase 3 iniciada)

### Pendência herdada da F2-15, deliberadamente NÃO resolvida na F2-17

O CHECK `polymarket_series_category_check` (0028) aceita só `OVERALL`, e a
F2-15 descobriu por probe que a API oficial aceita **onze** categorias. A F2-17
aceita o enum oficial de onze e **recusa** a janela sem série com
`SERIES_NOT_COLLECTED` — ampliar o CHECK sem ampliar a INGESTÃO permitiria
gravar séries que o job de ingestão não produz, e soltar um CHECK em migração já
aplicada exige backup e janela própria do runbook. A ingestão multi-categoria é
card próprio. Ver `docs/F2-17-POLYMARKET-SIMULATION.md` §4.

## Produção

- Fonte em produção: `891ffa53` (janela FULL pós-BETS-02) — **19 commits atrás
  do main**, com 11 migrações não aplicadas (0019→0028 mais a 0030 da F2-17,
  quando a branch for integrada).
- **Domínio de produção: `stakeframe.com.br`** (`APP_DOMAIN` do container web).
  `stakeframe.app` **não** é o domínio do produto — o DNS o resolve para um IP
  sem relação com a VPS.
- **IP público da VPS: `129.146.113.111`.** O `129.146.113.29` que aparecia em
  material antigo é o IP anterior da Oracle; a VM nunca foi reiniciada (uptime
  contínuo de 2+ semanas). Se a Oracle trocar o IP de novo, atualizar aqui.
- **Health check:** o Docker healthcheck é o autoritativo (`Status=healthy`,
  `FailingStreak=0`). No HTTP, `/health`, `/healthz` e `/readyz` respondem 200
  (servem o shell do SPA); `/api/health` responde 404 porque a rota não existe.
- Decisão do proprietário (29/09/2026): **não promover** até fechar a Fase 2.
  O deploy será único e coeso, com plano de migração testado e janela de
  rollback, precedido de auditoria de produção (digests, conectividade).
- Backup, telemetria (Sentry/PostHog/BetterStack) e LGPD estão ativos e
  saudáveis na VPS desde a janela FULL.

## Pendências que exigem o dono

- Autorização de deploy (quando a Fase 2 fechar)
- Autorização dos gates G0-05 (auditoria de acessos), G0-06 (failover de infra)
  e G0-07 (revisão de lacunas M0)
- Autorização de F2-18 (gate de ativação Polymarket)
- Higiene: mover credenciais de `dev/backblaze/*.txt` para o gestor de senhas
  (os segredos já estão na VPS; o resto é higiene local)

## Como este arquivo se mantém

Atualizado pelo orquestrador a partir do kanban e do `main` real — nunca de
memória. Se este texto divergir do kanban, **o kanban vence**.
