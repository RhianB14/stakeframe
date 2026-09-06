# STK-M0-14 — Preparação do Google OAuth de produção

Registro de 2026-09-06, associado à [issue #28](https://github.com/RhianB14/stakeframe/issues/28).
Configuração e verificação executadas diretamente pelo Codex, conforme a
diretriz temporária de [AGENTS.md](../AGENTS.md). Não constitui revisão
independente no GitHub nem validação do login em produção.

## Autorização e configuração

O proprietário aprovou expressamente concluir o consentimento, aceitar a
[Política de Dados do Usuário das APIs Google](https://developers.google.com/terms/api-services-user-data-policy),
criar o cliente web com o callback abaixo e guardar as credenciais em arquivo
privado fora do Git. Ao retomar, o console já mostrava o consentimento criado.

| Item               | Estado conferido                                          |
| ------------------ | --------------------------------------------------------- |
| Projeto            | `stakeframe-production-2026`, separado do desenvolvimento |
| Nome do projeto    | Stakeframe Producao                                       |
| Nome do aplicativo | Stakeframe                                                |
| Cliente            | Stakeframe Producao Web, tipo Aplicativo da Web, ativado  |
| Público            | Externo, status de publicação Em teste                    |
| Usuário de teste   | Uma conta, do proprietário                                |
| Escopos            | `openid`, `userinfo.email`, `userinfo.profile`            |
| Domínio autorizado | `stakeframe.com.br`                                       |
| Callback único     | `https://stakeframe.com.br/api/auth/callback/google`      |
| Origens JavaScript | Nenhuma; o fluxo é iniciado pelo servidor                 |

O suporte e o contato do desenvolvedor usam a conta do proprietário. URLs de
página inicial, privacidade e termos do aplicativo permanecem vazias, pois
essas páginas ainda não foram implantadas. Não houve publicação do aplicativo
OAuth nem solicitação de escopos sensíveis ou restritos.

## Verificações executadas

- Console confirmou a gravação de público, escopos e domínio; o cliente foi
  criado e seus detalhes foram reabertos para conferir o callback persistido.
- Client ID e segredo foram salvos em `google_client_id` e
  `google_client_secret`, sob o diretório privado `production-oauth`, fora
  do workspace e do Git. Metadados registram origem, callback, escopos e
  `productionLoginValidated=false`.
- No Windows, a pasta tem herança de ACL desativada, com acesso somente ao
  usuário local e SYSTEM. Os três arquivos herdam apenas essas duas entradas.
- O segredo não foi incluído em argumentos, screenshots, saída de ferramentas,
  commits, imagens ou CI. O diálogo de criação foi fechado após a gravação.
- O cliente local e seus arquivos de configuração permanecem separados.

O status Em teste não é a fronteira de autorização: o Google documenta
[exceções para os escopos básicos](https://support.google.com/cloud/answer/15549945?hl=en).
A API deve sempre exigir o `sub` e o e-mail verificado exatos do proprietário,
como já implementado em [AUTHENTICATION.md](AUTHENTICATION.md).

## Limites e próxima validação

Esta tarefa prepara credenciais; não iniciou login de produção, emissão de
certificado, alteração de DNS/firewall, cópia de segredos para a VPS, deploy
ou migração. Nenhum código, dependência ou schema foi alterado.

Após a implantação autorizada, configurar o client ID no arquivo privado de
deployment e montar o segredo somente na API, conforme
[PRODUCTION-CONFIGURATION.md](PRODUCTION-CONFIGURATION.md). Confirmar a
identidade privada já verificada, criar os demais segredos com autorização
própria e cumprir os gates de [DEPLOYMENT.md](DEPLOYMENT.md).

A validação real ainda deve conferir HTTPS público válido, callback exato,
login do proprietário, recarga, logout, revogação da sessão e recusa de
identidade divergente. M0 permanece em andamento.
