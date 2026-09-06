# STK-M0-09 — Evidências dos contratos da API

Data: 2026-09-06. Escopo: contratos, documentação e validação da base local.

## Verificações locais

- Node 24.20.0 e pnpm 11.24.0: tipos, ESLint e build TypeScript/Vite aprovados.
- 39 testes unitários aprovados. Os novos casos verificam cobertura das sete
  rotas pelo OpenAPI, ausência de acesso ao banco na exportação, entrada inválida,
  campos privados extras removidos e 500 sanitizado para resposta incompatível.
- 24 testes de integração aprovados com PostgreSQL 18 real: três de banco/fila
  e 21 de autenticação. A suíte mantém os casos de identidade, assinatura,
  PKCE/estado, origem, expiração, revogação e cookies; agora verifica também os
  DTOs reais, envelope de rate limit e login/logout com corpo ausente.
- OpenAPI 3.0.3 aprovado pelo Swagger Parser 13.0.0, com resolução externa
  desativada. `pnpm api:spec:check` confirmou o documento versionado atualizado.
- `pnpm audit`: nenhuma vulnerabilidade conhecida reportada.
- Compose recompilado; quatro serviços saudáveis e migração concluída com
  código zero. Nenhuma alteração de schema ou migração nova nesta tarefa.
- A especificação servida via Caddy local corresponde integralmente ao arquivo
  versionado. Status confirmou banco disponível e autenticação Google; uma
  chamada anônima a `/api/v1/me` retornou 401 no contrato esperado. Recarga da
  aplicação no Chrome manteve a sessão real e a confirmação de acesso privado.

## Regressão e limites

Os testes de autenticação criam e removem seu próprio banco temporário, usando
respostas Google simuladas com tokens de teste assinados. A ativação e os testes
Google reais anteriores estão em [M0-08-VALIDATION.md](M0-08-VALIDATION.md).
Credenciais reais permanecem fora do Git e do contexto Docker.

A CI executa adicionalmente os 16 cenários de navegador desktop/mobile em uma
instância nova com autenticação desativada por padrão, além das simulações do
guard de rede. O resultado por commit é registrado na PR. Esses cenários de UI
usam respostas de autenticação controladas; não são uma nova validação Google real.

Nenhum teste nesta etapa comprova ARM64 na VPS, TLS público, publicação ou
operações financeiras. M0 permanece em andamento.
