# STK-M0-39 — Validação do Google OAuth em produção

Data: 2026-09-11. Base validada:
`bcdbb53d4d0be229d88dacd244296aacc7f035a8`. A validação usou o site público
`https://stakeframe.com.br` e a conta do proprietário já autorizada. Senha,
MFA, e-mail completo, `sub`, tokens, cookies e demais identificadores privados
não foram lidos nem registrados.

## Resultado

O login Google real de produção foi **validado**. O Hermes executou o preflight
somente leitura e abriu o fluxo. A sessão autenticada já estava concluída quando
o proprietário transferiu a execução ao Codex, que verificou recarga, logout e
impossibilidade de recuperar a sessão pela navegação do navegador.

| Etapa                          | Resultado                                                                   |
| ------------------------------ | --------------------------------------------------------------------------- |
| HTTPS e headers da aplicação   | PASS — HTTPS válido; HSTS, CSP e proteção contra framing presentes          |
| Início sem `Origin`            | PASS — HTTP 403                                                             |
| Início com origem de produção  | PASS — redirecionamento somente para `accounts.google.com/o/oauth2/v2/auth` |
| Callback configurado           | PASS — `https://stakeframe.com.br/api/auth/callback/google` exato           |
| Proteções OAuth                | PASS — `state` opaco e PKCE S256 presentes                                  |
| Callback sem `state`/`code`    | PASS — falha genérica, sem conceder acesso                                  |
| Estado anterior ao login       | PASS — rota de sessão respondeu 401 `UNAUTHENTICATED`                       |
| Login da identidade autorizada | PASS — aplicação exibiu o espaço privado após o callback real               |
| Persistência após recarga      | PASS — uma recarga completa manteve o estado autenticado                    |
| Logout                         | PASS — a interface voltou à tela de entrada                                 |
| Recarga após logout            | PASS — permaneceu desautenticada                                            |
| Navegação anterior após logout | PASS — voltar para uma rota privada manteve a tela de entrada               |
| Erros do navegador             | PASS — nenhum erro de console foi observado no encerramento do fluxo        |

## Separação das evidências

O preflight do Hermes comprovou a origem, o destino Google, o callback, PKCE,
`state`, as recusas e o estado anônimo inicial. O Codex observou uma sessão real
já autenticada, recarregou a aplicação, acionou o logout e verificou o estado
anônimo após recarga e após o botão Voltar. Não houve alteração de configuração,
credenciais, imagens, serviços ou banco por acesso administrativo.

O login e o logout podem, por contrato, criar e revogar a sessão normal do
proprietário. Nenhuma leitura direta do banco foi feita nesta tarefa. A
persistência após recarga e a recusa após logout comprovam o comportamento
externo esperado.

## Cookies e limites

A sessão real funcionou somente em HTTPS, sobreviveu à recarga e deixou de
autorizar acesso após o logout. O controle do navegador usado nesta validação
não expõe os atributos do cookie `HttpOnly` ao documento nem fornece uma visão
sanitizada de `Secure`/`SameSite`; por isso estes atributos não são apresentados
como leitura independente do cookie de produção. O contrato versionado exige
`HttpOnly`, `Secure` e `SameSite=Lax`, e a suíte automatizada os verifica.

Não foi usada uma segunda conta Google real. As recusas por `sub`, e-mail,
verificação, emissor, audiência e assinatura continuam cobertas pelos testes de
integração. Nenhuma URL de callback válida foi preservada para repetição; o teste
externo de não reutilização foi feito sobre a sessão encerrada, por recarga e
navegação anterior.

## Garantias

- Nenhuma senha, MFA, credencial, token, cookie, e-mail completo, `sub` ou dado
  financeiro foi incluído na evidência versionada, issue, PR ou devolutiva
  pública.
- Nenhuma configuração Google Cloud, credencial, segredo, VPS, Compose, imagem,
  serviço, DNS ou banco foi alterado administrativamente.
- Nenhum deploy, migração, restart ou rollback foi executado.
- O estado final do navegador está desautenticado.
