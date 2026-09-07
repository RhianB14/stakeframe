# Contratos da API local

A STK-M0-09 liga os schemas Zod compartilhados à validação de entrada e à
serialização das respostas Fastify. A mesma definição gera o documento
[OpenAPI 3.0.3](openapi.json), disponível também em `GET /api/openapi.json`.
O documento usa a origem relativa `/` e não depende de banco ou credenciais.

## Rotas disponíveis

| Método | Caminho                     | Resultado principal                                               |
| ------ | --------------------------- | ----------------------------------------------------------------- |
| GET    | `/health/live`              | 200: processo em execução                                         |
| GET    | `/health/ready`             | 200: banco disponível; 503: `status: unavailable`                 |
| GET    | `/api/v1/system/status`     | 200: estado técnico, incluindo disponibilidade do banco           |
| POST   | `/api/auth/sign-in/google`  | 200: URL Google e `redirect: false`                               |
| GET    | `/api/auth/callback/google` | 302: retorno OAuth, com `Location` e cookies, sem corpo JSON      |
| POST   | `/api/auth/sign-out`        | 200: `success: true`                                              |
| GET    | `/api/v1/me`                | 200: id, nome e expiração da sessão; 401: sessão ausente/inválida |
| GET    | `/api/v1/workspace`         | 200: saldos, contas, catálogos, unidades, freebets e versão       |
| POST   | `/api/v1/commands`          | 200: recibo de comando financeiro idempotente                     |
| GET    | `/api/v1/bets`              | 200: apostas paginadas e filtradas                                |
| GET    | `/api/v1/bets/{id}`         | 200: aposta, seleções e histórico de liquidações                  |
| GET    | `/api/v1/journal`           | 200: lançamentos e estornos paginados                             |

As mutações de autenticação exigem `Origin` igual à origem configurada. O corpo
pode ser ausente, `null` ou objeto; campos enviados são ignorados. Provedor,
callback e modo de redirecionamento são definidos pelo servidor. Arrays,
primitivos, JSON inválido e callback com parâmetros repetidos ou maiores que os
limites são recusados antes de chamar a autenticação.

`/api/v1/me` usa o cookie HttpOnly de sessão própria: `stakeframe.session_token`
no HTTP de loopback ou `__Secure-stakeframe.session_token` em HTTPS. Os esquemas
de segurança OpenAPI representam alternativas para esses ambientes. Logout
também funciona sem sessão. Tokens Google não autenticam chamadas da API.
Política completa em [AUTHENTICATION.md](AUTHENTICATION.md).

## Erros e respostas

Os erros JSON têm a forma abaixo. O UUID é gerado pelo servidor, sem confiar no
identificador enviado pelo cliente. Mensagens internas e detalhes de validação
não são devolvidos.

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Entre com a conta autorizada para continuar.",
    "requestId": "e61c69ef-5cdd-42ea-9a3e-1c7b6da9408c"
  }
}
```

| Código                | Significado                                           |
| --------------------- | ----------------------------------------------------- |
| `NOT_FOUND`           | Rota inexistente                                      |
| `INVALID_REQUEST`     | Entrada recusada pelo servidor                        |
| `INTERNAL_ERROR`      | Falha interna ou resposta incompatível com o contrato |
| `AUTH_NOT_CONFIGURED` | Autenticação desativada ou não configurada            |
| `UNAUTHENTICATED`     | Sessão ausente, expirada ou identidade recusada       |
| `ORIGIN_NOT_ALLOWED`  | Origem da mutação recusada                            |
| `AUTH_REQUEST_FAILED` | Solicitação recusada pela biblioteca de autenticação  |
| `RATE_LIMITED`        | Limite de tentativas atingido                         |
| `AUTH_UNAVAILABLE`    | Serviço de autenticação temporariamente indisponível  |

As rotas documentam os status esperados e um contrato de erro `default` para
outros status. O readiness 503 mantém seu formato técnico de healthcheck; falhas
OAuth que redirecionam mantêm 302 com destino genérico. Esses dois casos não
usam o envelope de erro JSON.

Respostas JSON são validadas na saída. Campos extras de objetos são removidos;
campos obrigatórios inválidos resultam em 500 sanitizado. O adaptador de
autenticação converte o JSON da biblioteca em objeto antes da serialização,
preservando os cookies e cabeçalhos de controle. Todas as respostas usam
`Cache-Control: no-store`. Todas as rotas financeiras exigem sessão do
proprietário antes da validação dos dados. Mutações exigem `Origin` autorizado,
`Idempotency-Key` UUID e `expectedVersion`. Dinheiro e odds são strings decimais;
datas financeiras são instantes ISO com offset. Não há chaves de serviço que
substituam a sessão. Fluxos e erros de domínio em [FINANCIAL-MODEL.md](FINANCIAL-MODEL.md).

## Atualização e verificação

Importações usam `GET/POST /api/v1/imports`, `GET /api/v1/imports/:id` e
`GET /api/v1/imports/:id/image`. Upload aceita JSON com imagem base64 e legenda;
o limite binário é 8 MiB. Sessão e origem são verificadas antes de analisar o
corpo. O POST exige `Idempotency-Key`; repetir com outro conteúdo retorna 409.
Listagens aceitam paginação, situação e `betId`. Imagens respondem como PNG/JPEG,
sem endereço público do objeto e com `no-store`.

`import.confirm`, `import.discard` e `import.retry` usam `/api/v1/commands`,
`expectedVersion` financeiro e `expectedInboxVersion`. A decisão de confirmação
é `create` com os dados conferidos da aposta ou `link` com aposta e justificativa.
`DUPLICATE_REVIEW_REQUIRED` exige conferir os candidatos e justificar o novo
registro. `INVALID_INBOX_IMAGE`, `INBOX_BUSY`, `INBOX_CAPACITY_REACHED` e
`ATTACHMENT_UNAVAILABLE` distinguem arquivo inválido, admissão ocupada,
capacidade temporária e imagem ausente. [IMPORTS.md](IMPORTS.md).

```bash
pnpm api:spec        # compila a API e atualiza docs/openapi.json
pnpm api:spec:check  # valida OpenAPI e falha se o documento versionado divergir
```

Edite os schemas em `packages/shared/src/index.ts` e a documentação das rotas
em `apps/api/src`; gere o JSON e revise o diff. Não edite o JSON gerado à mão.
A exportação não inicia servidor nem usa variáveis privadas. O parser verifica
o documento e suas referências internas, com resolução externa desativada.

A CI executa a comparação do documento gerado. Testes adicionais conferem a
cobertura das rotas, rejeição de entradas inválidas, filtragem de campos,
erro de serialização e regressões do fluxo OAuth com PostgreSQL real. O próprio
endpoint da especificação e os HEAD automáticos não são operações duplicadas
no documento.
