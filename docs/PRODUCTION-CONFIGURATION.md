# Configuração de produção e ensaio local

STK-M0-12 prepara o runtime da base existente para HTTPS e autenticação
obrigatória. A configuração é ensaiada em Docker local com identidades
fictícias. Produção na VPS continua sem implantação; os gates operacionais
em [DEPLOYMENT.md](DEPLOYMENT.md) permanecem obrigatórios.

## Contrato do runtime

`STAKEFRAME_RUNTIME=local` mantém o desenvolvimento existente. O modo
`production` também exige `NODE_ENV=production`. A API exige
`AUTH_ENABLED=true`, a identidade Google exata e uma origem HTTPS com nome
DNS e porta padrão. HTTP, loopback, credenciais na URL, caminhos, parâmetros
e fragmentos são recusados. A sessão continua limitada ao proprietário por
`sub` e e-mail verificado, com cookies Secure/HttpOnly e proteção de origem.

API, worker e migrador usam `stakeframe_app` no serviço interno `postgres`,
banco `stakeframe`. Esse papel é proprietário do banco, sem superusuário,
criação de bancos/papéis, replicação ou bypass de RLS. PostgreSQL tem senha
administrativa própria. O script de inicialização cria o papel apenas em
volume novo; alteração de arquivo de senha não rotaciona credenciais de um
banco já inicializado.

Segredos são arquivos montados em `/run/secrets`. Produção recusa valores
diretos e ambiguidades entre `VAR` e `VAR_FILE`. Não escrever segredos em
comandos, imagens, Git, relatórios ou arquivos públicos. Docker Compose
monta arquivos locais; isso não é armazenamento criptografado de segredos.
Referência: [secrets do Compose](https://docs.docker.com/reference/compose-file/secrets/).

| Arquivo privado        | Conteúdo / consumidor                                              |
| ---------------------- | ------------------------------------------------------------------ |
| `postgres_password`    | Senha administrativa aleatória / somente PostgreSQL                |
| `db_password`          | 32 bytes aleatórios em hex (64 caracteres) / banco e serviços Node |
| `auth_secret`          | Segredo aleatório com pelo menos 32 caracteres / API               |
| `google_client_secret` | Segredo do cliente Google de produção / somente API                |

O diretório no host deve ser privado. Na VPS Linux, os arquivos destinados
ao Node precisam ser legíveis pelo UID 1000; o administrador do host controla
essas permissões. Os campos `uid/gid/mode` de secrets com origem em arquivo
não substituem as permissões do arquivo de origem. Não aplicar mudanças de
credenciais/permissões durante uma revisão de configuração.

## Compose e imagens

`compose.production.yml` não constrói imagens. O arquivo privado derivado de
[deployment.env.example](../infra/production/deployment.env.example) aponta
os quatro artefatos revisados por digest: API, worker, migrador e
`web-production`. O checker recusa tags mutáveis. A publicação dessas imagens
e a escolha de digests reais são etapas posteriores.

Somente o web publica TCP 80/443, encaminhados às portas sem privilégio
8080/8443 do Caddy. PostgreSQL, API, worker e migrador não publicam portas.
Banco/worker/migrador ficam na rede interna; API tem saída para o Google.
Os serviços Node e web executam sem root, com filesystem somente leitura,
capabilities removidas e limites de recursos. Volumes persistem o banco,
certificados e configuração Caddy. O healthcheck privado do web comprova o
processo Caddy; o smoke test HTTPS deve conferir também a API e o banco.

O Caddy usa ACME público no artefato `web-production`, sem painel administrativo,
e preserva os certificados em `/data`. A emissão real depende de DNS e
acesso externo em 80/443. Não usar o certificado interno do ensaio na VPS.
Referência: [opções do Caddy](https://caddyserver.com/docs/caddyfile/options).

O Fastify continua sem confiar em headers de proxy enviados pelo cliente.
Os limites de login existentes são, portanto, compartilhados pelo endereço
interno do Caddy. Isso é conservador para esta base de um proprietário; uma
política por IP público exige definir e testar a identidade do proxy antes
de habilitar confiança em `X-Forwarded-*`. Acesso via CDN também exige revisão
própria dessa fronteira.

## Verificação sem implantação

```bash
node scripts/deployment-check.mjs /caminho/privado/deployment.env
```

Esse comando renderiza o Compose e valida imagens imutáveis, portas, redes,
mapeamento/presença/leitura dos arquivos de segredos e perfil de migração.
Não lê o conteúdo dos segredos nem valida suas credenciais externas. Não acessa o daemon, baixa imagens, inicializa
serviços nem aplica migrações. A saída não contém configuração ou credenciais.
Validação de configuração não constitui autorização operacional.

## Ensaio descartável

```bash
pnpm deployment:rehearse
```

O runner exige Docker local, constrói as quatro imagens, gera credenciais
fictícias em diretório privado e usa um projeto `stk-deploy-<uuid>`. A
composição aplica o mesmo arquivo de produção com duas substituições para
teste: portas efêmeras em loopback e CA interna do Caddy. Imagens são fixadas
por ID do daemon; o checker de produção continua recusando esses IDs como
substitutos de digests publicados.

O cliente HTTPS confia somente na CA daquela execução, sem instalar raízes
no computador nem desativar validação TLS. O teste verifica migração explícita
e repetível, papéis do banco, serviços privados, autenticação obrigatória,
origem recusada, cookies seguros, callback HTTPS e persistência de dados e
certificado após reinício. O início OAuth não completa login no Google; não
usa conta ou credenciais reais. A validação de protocolo Google existente
continua na suíte de integração.

A limpeza confere os labels de projeto e execução antes de remover apenas
containers, redes e volumes próprios. Os arquivos temporários são removidos
individualmente, após validar o caminho e a lista conhecida. O relatório
sanitizado fica em `.cache/deployment-reports`; imagens e cache podem permanecer.

## Limites

O ensaio não prova DNS, ACME público, rede/armazenamento da VPS, restauração de
produção, R2 ou OAuth real de produção. Não cumpre RPO/RTO. O schema permanece
apenas de autenticação e operação; as funcionalidades de produto continuam
fora do M0. [DEPLOYMENT.md](DEPLOYMENT.md) define a futura operação.
