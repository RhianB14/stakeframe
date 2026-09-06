# STK-M0-07 — Validação da base local

Registro de 2026-09-06, vinculado à [issue #14](https://github.com/RhianB14/stakeframe/issues/14).
Escopo: fundação executável local; não conclui M0 nem valida produção.

## Ambiente e resultados

Windows com Node 24.20.0/pnpm 11.24.0 isolados; Docker Desktop com containers
Linux AMD64. Projeto de teste `stk-m0-07-review-9019`, portas de loopback 8088
e 55432. PostgreSQL confirmou versão 18.4; API confirmou Node 24.20.0 x64.

| Verificação                                     | Resultado local                                   |
| ----------------------------------------------- | ------------------------------------------------- |
| `pnpm install --frozen-lockfile`                | Passou, lockfile consistente                      |
| `pnpm typecheck`                                | Passou nos pacotes e testes                       |
| `pnpm lint`                                     | Passou                                            |
| `pnpm test`                                     | 16 testes passaram                                |
| `pnpm build`                                    | Pacotes TypeScript e build Vite passaram          |
| Compose `up -d --build --wait`                  | PostgreSQL, API, worker e web saudáveis           |
| `pnpm local:test-db`                            | 3 testes passaram com PostgreSQL 18.4 real        |
| `pnpm test:e2e` com `PLAYWRIGHT_CHANNEL=chrome` | 6 testes passaram, desktop e mobile               |
| Simulações Python do guard existente            | 73 testes passaram em container Linux descartável |

Os testes de banco verificaram consulta Drizzle/readiness, consumo de job com
resultado persistido e payload inválido terminando em `failed` após duas
tentativas adicionais. Cada execução cria e remove somente seu schema aleatório
de teste. O worker do Compose mantém o schema técnico `pgboss` local.

Os E2E verificaram a conexão real por Caddy/API, indisponibilidade simulada,
botão de tentar novamente, banco indisponível, resposta 404 nas rotas de
produto inexistentes, ausência de erros JavaScript e de overflow horizontal.
Screenshots de desktop (1440 × 1000) e mobile (perfil Pixel 7) foram inspecionados.

O download do Chromium 153 fixado pelo Playwright expirou no ambiente Windows.
A execução local utilizou **Chrome 151.0.7922.174 instalado**, via canal explícito.
Não se declara execução local no Chromium empacotado. O workflow de CI instala
esse Chromium no runner Linux e executa a mesma suíte; consultar o resultado
vinculado ao head da PR.

As simulações de rede usaram o código desta branch montado somente para leitura,
sem rede/capabilities, com `/tmp` descartável e Python 3.12 disponível na imagem
local de testes. Não foram testes de firewall/systemd real nem acesso à VPS.

## Limites

- Nenhuma funcionalidade financeira, autenticação ou integração externa foi
  habilitada. A interface explicita a preparação do acesso Google.
- Banco local contém apenas infraestrutura técnica da fila. Nenhuma migração
  de domínio ou de produção foi executada.
- Imagens base têm manifests AMD64/ARM64, mas execução ARM64 ainda não foi validada.
- Credenciais geradas ficam em `.env.local`, fora do Git e do contexto Docker.
- Reconciliação da VPS (issue #11/PR #13), DNS/HTTPS, R2, OAuth, Telegram,
  OmniRoute, backups e teste de restauração continuam pendentes.
- A PR desta tarefa não altera proteções de branch nem autoriza merge/deploy.
