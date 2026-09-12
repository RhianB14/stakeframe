# STK-M0-58 — política de redirect do monitor (`manual`, fail-closed)

Data: 12/09/2026
Estado: correção implementada; validação de produção pendente de autorização

## 1. Matriz sanitizada da STK-M0-57

O Worker temporário de diagnóstico (sem secrets, bindings ou cron; excluído ao
final) executou uma vez cada variante contra o hostname real
`stakeframe.com.br`:

| Variante (caminho × redirect)                            | Resultado                  | Duração    |
| -------------------------------------------------------- | -------------------------- | ---------- |
| `/health/live` × `manual`                                | 200                        | ~1,1 s     |
| `/health/live` × `error`                                 | **TypeError, sem conexão** | **0–5 ms** |
| `/health/live` × `follow`                                | 200                        | ~1,1 s     |
| `/api/v1/operations/health` × `manual`                   | 401                        | ~1,1 s     |
| `/api/v1/operations/health` × `error`                    | **TypeError, sem conexão** | **0–5 ms** |
| `/api/v1/operations/health` × `follow`                   | 401                        | ~1,1 s     |
| `/api/v1/operations/health` × `manual` + bearer fictício | 401                        | ~0,2–1,1 s |
| `/api/v1/operations/health` × `error` + bearer fictício  | **TypeError, sem conexão** | **0–5 ms** |

Chegada na VPS (captura read-only): as variantes `manual`/`follow` abriram
conexões reais (faixas Cloudflare publicadas) e receberam 200/401; as variantes
`error` não abrem conexão alguma. Nenhuma rota testada retornou redirect real
(`Location` ausente em todas), e o disparo real do monitor na mesma janela
concluiu sem nenhuma conexão chegar à VPS.

## 2. Causa comprovada

O runtime atual do Cloudflare Workers **recusa `redirect: 'error'`
incondicionalmente**: o `fetch` rejeita com `TypeError` antes de abrir conexão,
independentemente de rota, origem ou header. O monitor usava esse modo no fetch
da saúde e no envio ao Telegram; por isso toda sonda falhava instantaneamente
como `health_check_network` (sem `lastHttpStatus`) e nenhuma entrega podia
confirmar.

## 3. Correção

Em `infra/monitor/worker.mjs`, os dois fetches externos passam a usar
`redirect: 'manual'`. Redirects **continuam bloqueados** (fail-closed):

- a saúde nunca segue redirect: qualquer resposta 3xx cai no guard existente
  `!response.ok` e resulta em `signature=application:failed`,
  `failure=health_check_http`, `httpStatus` com o código 3xx, corpo cancelado;
- o Telegram nunca segue redirect: um 3xx não é `ok`, o corpo é cancelado, a
  tentativa permanece `uncertain` e `/check/confirm-delivery` não é chamado;
- nada de `Location`, URL completa, headers, bearer, mensagem de erro ou stack
  é persistido ou registrado.

Preservados sem alteração: timeouts, validação de payload, protocolo
`/check/start` → `/check/complete` → `/check/confirm-delivery`, lease,
persistência, deduplicação, contrato do `/status`, schema SQLite, mensagens de
alerta e configuração do Wrangler.

## 4. Testes

- os mocks passam a exigir `redirect: 'manual'` em todas as chamadas;
- saúde com 302: sem segunda chamada/follow, `lastResult=failed`,
  `lastError=health_check_http`, `lastHttpStatus=302`,
  `lastSignature=application:failed`, conclusão e lease consistentes (e o ciclo
  seguinte volta a `ready`);
- Telegram com 302: nenhuma chamada ao destino do `Location`, `delivery`
  permanece `uncertain`, `/check/confirm-delivery` não é chamado, corpo 3xx
  cancelado, estado e assinatura do incidente preservados.

## 5. Limites

Validação operacional pendente: a correção só poderá ser declarada operacional
após merge, release e deploy autorizados, com duas leituras autenticadas do
`/status` (≥1 ciclo) comprovando `lastHttpStatus=200`, `lastError=null` e
assinatura correspondente aos checks reais. Nenhum deploy, migração, alteração
de segredo, trigger, binding ou produção integra esta tarefa.
