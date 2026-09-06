# STK-M0-08 — Evidências de autenticação local

Data: 2026-09-06. Escopo: código, banco e autenticação locais. Os testes
automatizados substituem o Google na fronteira HTTP; uma validação posterior,
autorizada pelo proprietário, usa o Google e a conta reais.

## Verificações

- Tipos, ESLint e build TypeScript/Vite concluídos com Node 24.20.0 e pnpm 11.24.0.
- 32 testes unitários: configuração, contratos, rotas técnicas e comportamento
  de autenticação desativada/inválida.
- 23 testes de integração: 3 de PostgreSQL/pg-boss e 20 de autenticação com
  Fastify, Better Auth, adapter Drizzle e PostgreSQL 18 reais.
- 16 testes de navegador em desktop/mobile, executados localmente com Chrome
  151.0.7922.174 (`PLAYWRIGHT_CHANNEL=chrome`). CI usa Chromium do Playwright.
  Capturas de login revisadas nos dois tamanhos, sem overflow horizontal.
- Migração aplicada no volume local existente; serviço `migrate` terminou com
  `LOCAL_MIGRATIONS_COMPLETE`, e os quatro serviços permanentes ficaram saudáveis.
  Nenhum dado real de usuário foi criado pelos testes automatizados.
- `pnpm audit` não reportou vulnerabilidades conhecidas na execução local.

## O que os testes de autenticação demonstram

Cada suíte cria um banco `stk_auth_test_<uuid>` e remove somente esse banco ao
final. A migração roda duas vezes, mantendo um único registro no histórico.
Os testes assinam tokens fictícios RS256 e substituem os endpoints de token e
chaves Google; a troca de código confere o desafio/verificador PKCE. Chamadas
externas inesperadas falham, sem depender de internet ou de conta real.

São exercitados login do proprietário, rejeição por `sub`, e-mail ou verificação
incorretos, emissor/audiência/expiração/`azp` inválidos e assinatura adulterada;
ausência e repetição de estado; origem ausente, `null` ou externa; redirects
e headers de proxy adulterados; limites de login; cookie adulterado/expirado;
revogação no logout e alteração de identidade no banco. O cookie seguro também
é conferido com origem HTTPS em requisições injetadas, sem alegar teste TLS real.

A UI configurada é exercitada com respostas de API controladas pelo Playwright:
login, redirecionamento limitado ao Google, sessão, logout, falhas e recuperação.
Isso não adiciona nenhum modo de autenticação falsa ao runtime. Novos ambientes
e a CI mantêm autenticação desativada por padrão e recusam acesso privado.

## Validação com Google real após autorização

- Projeto dedicado a desenvolvimento, consentimento em teste e conta proprietária
  cadastrada como usuário de teste. Cliente web com apenas o callback local
  `http://127.0.0.1:8088/api/auth/callback/google` e escopos `openid`, `email`, `profile`.
- Credenciais gravadas diretamente no arquivo privado, com ACL restrita; nenhum
  segredo foi incluído no Git, contexto Docker ou evidência. O identificador
  permanente foi obtido por OpenID Connect com token verificado, sem cadastro aberto.
- Login completo da aplicação no Chrome, via Google real e callback da API:
  interface confirmou acesso privado. Recarga preservou a sessão.
- PostgreSQL apresentou um usuário, uma conta Google, uma sessão com validade
  de 12 horas e zero contas com access token, refresh token ou ID token persistidos.
- Logout pela interface removeu a sessão do banco (contagem zero), retirou a
  saudação privada e voltou ao botão de entrada. Requisição anônima a `/api/v1/me`
  retornou 401. Reutilização de cookie revogado é coberta pela integração automatizada.
- Teste negativo real: depois do logout, o `sub` autorizado foi temporariamente
  substituído por um marcador que recusa todas as contas. A mesma conta Google
  válida foi recusada, sem criar sessão, com mensagem genérica e URL limpa.
  A configuração original foi restaurada, e um novo login confirmou o acesso.
- Estado final: autenticação local ativada, identidade original restaurada,
  serviços saudáveis e aplicação aberta com a sessão do proprietário. O serviço
  temporário de confirmação de identidade já havia sido encerrado.

## Limites

- Uma segunda conta Google real não foi utilizada; a recusa real acima altera
  temporariamente a identidade permitida, sem ampliar acesso. Casos de outra
  conta, e-mail divergente e e-mail não verificado também têm testes automatizados.
- Nenhuma validação de VPS/ARM64, HTTPS público ou implantação de produção.
- Rate limit é local à instância, com IP do proxy no Compose; deve ser revisto
  junto à política de proxy de produção.
- Imagens locais ainda incluem ferramentas de desenvolvimento. Duas dependências
  transitivas do Drizzle Kit estão depreciadas; o esbuild vulnerável foi
  substituído por override restrito, documentado na decisão D011.
- M0 permanece em andamento e funcionalidades de apostas não fazem parte desta etapa.
