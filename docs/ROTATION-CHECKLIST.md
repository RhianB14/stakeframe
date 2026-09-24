# Checklist de rotação de credenciais — Gate 0

Preparação operacional da rotação de credenciais herdadas do M0, exigida pelo
item 5 do Gate 0 do PLANO-MASTER-STAKEFRAME-2026.md (rev. 2.0, §2): auditar
acessos históricos e rotacionar as credenciais atuais relevantes, invalidando
possíveis cópias antigas. A execução ocorre em janela autorizada, nos consoles
externos e na VPS; este arquivo descreve o procedimento e não contém segredos.

Referências: [PRODUCTION-CONFIGURATION.md](PRODUCTION-CONFIGURATION.md) ·
[OPERATIONS.md](OPERATIONS.md) · [AUTHENTICATION.md](AUTHENTICATION.md).

## Regras gerais

- Somente o proprietário executa a rotação, em janela autorizada; a regra 9 de
  [AGENTS.md](../AGENTS.md) exige autorização específica para alterações de
  credenciais, permissões e proteções.
- Produção aceita segredos somente como arquivos montados em `/run/secrets`, a
  partir do diretório privado da VPS (`SECRET_DIRECTORY`, hoje
  `/etc/stakeframe/secrets`). Nunca usar valores diretos.
- Nunca registrar valores em comandos, imagens, Git, relatórios, logs ou
  arquivos públicos; as evidências da rotação são sanitizadas.
- Trocar apenas o arquivo de senha não rotaciona um banco já inicializado: a
  nova senha precisa ser aplicada no próprio PostgreSQL (seções 1.2 e 1.3).
- Os arquivos consumidos pelos serviços Node precisam ser legíveis pelo UID
  1000; conferir as permissões do diretório privado antes da janela.
- Após cada rotação: substituir o(s) arquivo(s), recriar o(s) serviço(s)
  afetado(s), revalidar e registrar a evidência na seção 5.

## Varredura de higiene (STK-A2)

- Arquivos rastreados: nenhum segredo real. Apenas placeholders (`*_FILE=`
  vazios, `***`, `usuario:senha`) e fixtures sintéticos de teste em
  `scripts/ai/opencode-go.test.mjs` e nos testes unitários de OCR.
- Histórico completo (`git log --all`): nenhum segredo real commitado. As
  ocorrências de `postgresql://` são placeholders, expansões de ambiente ou
  fixtures; `client_secret` aparece apenas em fiação de configuração; chaves
  privadas aparecem apenas como string de validação em código; nenhuma chave
  `GOCSPX-`, AWS, GitHub ou Slack.
- `.gitignore` cobre `.env`, `.env.*` e `*.local` (inclui `.env.local` e
  `.env.auth.local`), preservando `!.env.example`; nenhum `.env` real é
  rastreado.
- Conclusão: o repositório não expõe cópias antigas; a rotação abaixo cobre a
  invalidação de cópias externas.

## 1. Núcleo do runtime e autenticação

### 1.1 Google OAuth client secret (Better Auth)

- Onde vive: Google Cloud Console (projeto de produção, client OAuth web);
  consumido pela API pelo arquivo privado `google_client_secret`
  (`GOOGLE_CLIENT_SECRET_FILE=/run/secrets/google_client_secret`).
- Quem rotaciona: proprietário.
- Passos:
  - [ ] Gerar um novo client secret no console (criar o novo e manter o
        anterior ativo somente durante a janela).
  - [ ] Substituir o conteúdo de `secrets/google_client_secret` (leitura pelo
        UID 1000).
  - [ ] Recriar o serviço `api` com os arquivos Compose vigentes.
  - [ ] Revalidar o login real do proprietário (callback + `/api/v1/me`) e a
        recusa de identidade não autorizada.
  - [ ] Revogar o secret anterior no console.
- Ambiente: arquivo `google_client_secret`; reiniciar `api`. `GOOGLE_CLIENT_ID`
  e a identidade (`AUTHORIZED_GOOGLE_EMAIL`/`AUTHORIZED_GOOGLE_SUB`) não mudam.
  No desenvolvimento local, o valor correspondente vive em `.env.auth.local`
  (fora do Git, com acesso restrito ao proprietário).

### 1.2 PostgreSQL 18 — senha administrativa (`postgres_password`)

- Onde vive: arquivo `secrets/postgres_password` (papel administrador do
  PostgreSQL; nenhum serviço Node o consome).
- Quem rotaciona: proprietário.
- Passos:
  - [ ] Aplicar a nova senha no banco (ALTER ROLE do papel administrador) e
        atualizar o arquivo em conjunto, na mesma janela.
  - [ ] Recriar `postgres` (e os dependentes) com os arquivos Compose
        vigentes.
  - [ ] Revalidar a saúde do banco e da aplicação (healthchecks).
- Ambiente: arquivo `postgres_password`; reiniciar `postgres`. Lembrete: trocar
  somente o arquivo não altera um banco já inicializado.

### 1.3 PostgreSQL 18 — senha da aplicação (`db_password`)

- Onde vive: arquivo `secrets/db_password` (papel `stakeframe_app`, sem
  superusuário, criação de papéis/bancos, replicação ou bypass de RLS; 32
  bytes aleatórios em hex). Consumido pela API, pelo worker e pelo migrador; o
  PostgreSQL usa na inicialização.
- Quem rotaciona: proprietário.
- Passos:
  - [ ] Aplicar a nova senha do papel `stakeframe_app` no banco e atualizar o
        arquivo.
  - [ ] Recriar `api` e `worker` (e o migrador, quando houver migração
        autorizada) para que releiam o segredo.
  - [ ] Revalidar conexões, healthchecks e um fluxo financeiro de leitura.
- Ambiente: arquivo `db_password`; reiniciar `api` e `worker`.

### 1.4 Segredo de sessão do Better Auth (`auth_secret`)

- Onde vive: arquivo `secrets/auth_secret`
  (`BETTER_AUTH_SECRET_FILE=/run/secrets/auth_secret`), consumido somente pela
  API; aleatório com pelo menos 32 caracteres.
- Quem rotaciona: proprietário.
- Passos:
  - [ ] Gerar um novo valor aleatório e substituir o arquivo.
  - [ ] Recriar a `api`.
  - [ ] Revalidar o fluxo de autenticação; sessões emitidas com o segredo
        anterior deixam de valer (novo login do proprietário é esperado).
- Ambiente: arquivo `auth_secret`; reiniciar `api`.

## 2. Integrações e operações

### 2.1 OpenRouter (`openrouter_api_key`)

- Onde vive: dashboard do OpenRouter (chave individual com limite mensal de
  US$5; o worker consulta os metadados da própria chave para conferir a cota);
  arquivo `secrets/openrouter_api_key` (`OPENROUTER_API_KEY_FILE`).
- Quem rotaciona: proprietário.
- Passos:
  - [ ] Criar uma nova chave no OpenRouter com o mesmo limite e política de
        gasto.
  - [ ] Substituir o arquivo e recriar o `worker`.
  - [ ] Conferir a cota conhecida no monitor e invalidar a chave anterior.
- Ambiente: arquivo `openrouter_api_key`; reiniciar `worker`.

### 2.2 Telegram (`telegram_bot_token` e identificadores)

- Onde vive: BotFather (token) e conversa privada do proprietário
  (`telegram_owner_user_id`, `telegram_owner_chat_id`). O mesmo token também é
  segredo do monitor externo no Cloudflare (`TELEGRAM_BOT_TOKEN`), que não
  possui trigger público.
- Quem rotaciona: proprietário.
- Passos:
  - [ ] Revogar e gerar um novo token no BotFather.
  - [ ] Substituir o arquivo na VPS e recriar o `worker`.
  - [ ] Atualizar o segredo no Cloudflare do monitor e republicar.
  - [ ] Revalidar a entrega (alerta somente em mudança de estado; conferir
        entrega incerta no estado privado do monitor).
- Ambiente: arquivo `telegram_bot_token`; reiniciar `worker`; republicar o
  monitor. Os identificadores só mudam se a conta ou a conversa mudar.

### 2.3 Chaves R2 (anexos e backups)

- Onde vive: Cloudflare (tokens de API R2 por bucket privado e distinto —
  anexos e backups). Arquivos e consumidores, conforme
  [OPERATIONS.md](OPERATIONS.md):
  - `r2_reader_access_key` / `r2_reader_secret_key` — API e operações; leitura
    apenas do bucket de anexos;
  - `r2_writer_access_key` / `r2_writer_secret_key` — worker; leitura, escrita
    e exclusão apenas no bucket de anexos;
  - `r2_backup_access_key` / `r2_backup_secret_key` — operações; bucket de
    backups;
  - `r2_backup_restore_access_key` / `r2_backup_restore_secret_key` — ensaio
    mensal; leitura apenas do bucket de backups.
- Quem rotaciona: proprietário.
- Passos:
  - [ ] Emitir novos tokens no dashboard com os mesmos escopos mínimos (access
        key com 32 caracteres hex; secret com 64).
  - [ ] Substituir os arquivos correspondentes e recriar os consumidores
        (`api`, `worker` e `operations`, conforme o caso).
  - [ ] Conferir os escopos reais no provedor (o checker local não prova
        permissões) e invalidar os tokens anteriores.
- Ambiente: arquivos `r2_*`; reiniciar os serviços consumidores. Os
  caminhos/campos do Compose não mudam.

### 2.4 `recovery_key`

- Onde vive: arquivo `secrets/recovery_key` (32 bytes aleatórios em hex) e
  cópia sob custódia fora da VPS.
- Quem rotaciona: proprietário.
- Passos:
  - [ ] Gerar um novo valor, atualizar o arquivo e a cópia de custódia.
  - [ ] Exercitar a verificação de recuperação na janela correspondente.
  - [ ] Invalidar cópias antigas conhecidas.
- Ambiente: arquivo `recovery_key`; operações e recuperação nas próximas
  execuções autorizadas.

### 2.5 `monitor_token`

- Onde vive: arquivo `secrets/monitor_token` (32 bytes em hex; API) e segredo
  do monitor externo no Cloudflare (`MONITOR_TOKEN`), que também protege o
  estado privado do monitor.
- Quem rotaciona: proprietário.
- Passos:
  - [ ] Gerar um novo token e atualizar o arquivo.
  - [ ] Atualizar o segredo no Cloudflare, republicar o monitor e recriar a
        `api`.
  - [ ] Revalidar `/api/v1/operations/health` e a leitura autenticada do
        `/status` do monitor.
- Ambiente: arquivo `monitor_token`; reiniciar `api`; republicar o monitor.

## 3. Integrações desativadas (rotacionar na ativação)

- `tavily_api_key` — chave do Tavily (plano básico, com os limites
  documentados); arquivo `tavily_api_key`; somente o worker, quando
  autorizado.
- Resend — `RESEND_API_KEY(_FILE)`; chave do domínio verificado, com remetente
  próprio; consumida pela API nos fluxos de e-mail/senha quando habilitados.
- OCR auxiliar — Azure Vision e Google Vision (`*_API_KEY_FILE`); desativados
  por padrão; rotacionar apenas quando a integração for ativada.

## 4. Verificação pós-rotação

```bash
node scripts/deployment-check.mjs /etc/stakeframe/deployment.env --integrations --operations
```

- [ ] Deployment-check renderiza sem erros (não lê o conteúdo dos segredos).
- [ ] Healthchecks (`/health/ready`) e monitor externo sem degradação.
- [ ] Login Google real do proprietário e recusa de identidade não autorizada.
- [ ] Próximo ciclo de backup/retenção concluído, com resultado no monitor.
- [ ] Evidências sanitizadas registradas no histórico abaixo.

## 5. Histórico de execução

| Credencial | Data | Executor | Evidência (sanitizada) |
| ---------- | ---- | -------- | ---------------------- |
| —          | —    | —        | aguardando janela      |
