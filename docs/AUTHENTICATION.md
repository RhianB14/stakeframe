# Autenticação do proprietário

## Estado e escopo

STK-M0-08 implementa Google OAuth com Better Auth e sessões no PostgreSQL.
A configuração padrão mantém `AUTH_ENABLED=false`: login e `/api/v1/me`
respondem 503, sem conceder acesso. Em 2026-09-06, após autorização específica
do proprietário, o Google Cloud foi configurado e o login real foi ativado e
validado no ambiente local. A STK-M0-14 preparou projeto e cliente separados
para produção, com credenciais privadas; implantação e login real de produção
continuam pendentes. [M0-14-VALIDATION.md](M0-14-VALIDATION.md).

## Política de acesso

- Somente Google, com `sub` exatamente igual a `AUTHORIZED_GOOGLE_SUB` e
  e-mail verificado igual a `AUTHORIZED_GOOGLE_EMAIL` (comparação em minúsculas).
  Não há equivalência por pontos, aliases, domínio ou primeiro usuário.
- O ID token é verificado pela biblioteca: assinatura Google, emissor,
  audiência e validade. Expiração é obrigatória; `azp`, quando presente, deve
  corresponder ao client ID. Esses dados são conferidos antes do cadastro.
- Sem senha, cadastro público, vinculação de contas, troca de e-mail ou
  exclusão de usuário por endpoint público. Rotas genéricas Better Auth não
  são expostas. Tokens Google são descartados antes de persistir a conta.
- Sessões duram no máximo 12 horas, sem renovação automática nem cache de
  sessão em cookie. Cada `/api/v1/me` consulta o banco e confere novamente a
  identidade. O DTO contém somente id, nome e expiração. Logout revoga a sessão.
- Cookies `HttpOnly`, `SameSite=Lax` e `Secure` em HTTPS. HTTP é aceito somente
  em loopback para desenvolvimento; nenhuma validação de HTTPS real foi feita.
- Estado OAuth persistido, cookie de estado e PKCE da biblioteca. Origem de
  POST deve coincidir com `APP_ORIGIN`; redirect e provider são fixos no servidor.
  Cabeçalhos de host/proxy enviados pelo cliente não definem origem nem IP.
- Limites em memória por IP: 5 inícios de login e 20 callbacks/minuto, além
  do limite geral de autenticação. No Compose, o proxy compartilha seu IP;
  isso é aceitável para o único proprietário local. Proxy confiável e limites
  compartilhados deverão ser definidos antes de produção ou múltiplas réplicas.

`/api/v1/system/status` e healthchecks continuam técnicos e públicos. Novas
rotas privadas de produto devem exigir a mesma verificação de proprietário;
não existe autorização global implícita para rotas que ainda serão criadas.

## Ativação local

A regra 9 de [AGENTS.md](../AGENTS.md) exige autorização específica para
alterações de credenciais. A ativação local abaixo foi autorizada e concluída
em 2026-09-06; as mesmas etapas servem como referência para outro ambiente,
com sua própria autorização e configuração:

1. Criar/configurar um client OAuth Google do tipo aplicação web no projeto
   dedicado à aplicação, com consentimento limitado ao uso pessoal e
   conta de teste do proprietário. Solicitar somente `openid`, `email` e `profile`.
2. Registrar o callback exato
   `http://127.0.0.1:8088/api/auth/callback/google`. Usar sempre esse host/porta,
   ajustando callback e `APP_ORIGIN` juntos se a porta local for alterada.
3. Confirmar o e-mail e obter o `sub` da identidade Google por um fluxo OpenID
   Connect autenticado e validado, em sessão privada. Não confiar em um JWT
   apenas decodificado, não adivinhar o identificador e não introduzir um
   cadastro temporário que aceite a primeira conta.
4. Guardar os valores fora do Git, em `.env.auth.local` (somente a API lê esse
   arquivo). Usar `AUTH_ENABLED=true`, `APP_ORIGIN`, `BETTER_AUTH_SECRET`
   aleatório com pelo menos 32 caracteres, `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `AUTHORIZED_GOOGLE_EMAIL` e `AUTHORIZED_GOOGLE_SUB`.
   Os nomes também estão em [.env.example](../.env.example), sem valores reais.
5. Executar `pnpm local:up`. Configuração incompleta impede a API de iniciar.
   Validar login proprietário, recusa de outra conta, recarga, logout e
   impossibilidade de reutilizar a sessão encerrada. Registrar somente
   resultados sanitizados, sem cookies, tokens, e-mails ou credenciais.

Não inserir segredos em argumentos, capturas, relatórios ou logs. O Compose
requer versão ≥2.24.0 para o [arquivo de ambiente opcional](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/).
A API ganha acesso
de saída à internet para o Google, mantendo suas portas sem publicação no host.

A configuração concluída usa um projeto de desenvolvimento, cliente do tipo
web, um único callback local e somente os três escopos básicos. O consentimento
permanece em modo de teste, com o proprietário cadastrado como usuário de teste.
A restrição efetiva depende sempre da conferência de `sub` e e-mail no servidor:
o Google documenta [exceções para os escopos básicos no modo de teste](https://support.google.com/cloud/answer/15549945?hl=en).

O identificador foi obtido com uma confirmação OpenID Connect temporária em
loopback, com estado, cookie, nonce, PKCE e verificação criptográfica do ID token,
exigindo o e-mail previamente definido. Essa confirmação não criou usuário nem
sessão no banco; o serviço temporário foi encerrado antes de subir a aplicação.
Nenhuma rota de cadastro temporário foi acrescentada ao runtime do produto.

O arquivo `.env.auth.local` está fora do Git e do contexto Docker, com herança
de ACL desativada no Windows e acesso somente ao proprietário local e SYSTEM.
Segredos, `sub`, e-mail e conteúdo de tokens não fazem parte da evidência versionada.

## Migrações locais

As tabelas Better Auth (`user`, `account`, `session`, `verification`) ficam no
schema `auth`; chaves, unicidade e índices das relações estão versionados em
`packages/db/migrations`. O histórico Drizzle fica em `drizzle`.

`pnpm local:up` executa o serviço `migrate` antes da API. Ele exige
`STAKEFRAME_RUNTIME=local`, usa conexão dedicada, lock consultivo e limites
de espera/execução. Aplicações repetidas não duplicam a migração. A migração
inicial é aditiva e não remove dados de `pgboss` ou do volume existente.

Para gerar uma alteração de schema durante desenvolvimento:

```bash
pnpm --filter @stakeframe/db exec drizzle-kit generate
```

Revisar SQL e snapshot antes de aplicar. Não editar migrações já aplicadas,
não usar `push` de schema nem excluir volume como correção. Uma falha impede
a API de subir; investigar com valores sanitizados. Não há rollback destrutivo
automático. Migrações de produção exigem plano de backup, recuperação e
autorização próprios.

A STK-M0-12 acrescenta a configuração de produção com origem HTTPS obrigatória,
segredos por arquivo e migração explícita em perfil separado. O Compose de
produção não aplica migrações no startup normal. Consulte
[PRODUCTION-CONFIGURATION.md](PRODUCTION-CONFIGURATION.md). O callback Google
de produção foi cadastrado na STK-M0-14; a implantação e o login real nesse
callback continuam pendentes.

## Evidência e limites

[M0-08-VALIDATION.md](M0-08-VALIDATION.md) registra testes e limitações.
Configuração Google Cloud, login, recarga, logout e recusa por identidade foram
validados localmente. HTTPS público e execução ARM64 na VPS ainda precisam de
validação. Esta entrega não conclui M0 nem autoriza deploy.
