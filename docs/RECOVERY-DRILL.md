# Ensaio local de recuperação — STK-M0-10

O comando `pnpm recovery:drill` demonstra backup criptografado e restauração de
um banco PostgreSQL 18 em um cluster novo. Ele cria dados próprios de teste,
confere o resultado e remove somente os recursos que criou. Não lê a instância
da aplicação, `.env.local` ou `.env.auth.local`.

Este é um ensaio técnico do M0. Não ativa backups da aplicação nem conecta R2.
O plano de recuperação completo permanece em [RECOVERY.md](RECOVERY.md).
O modo externo explícito da STK-M0-13 é descrito separadamente em [R2.md](R2.md).

## Execução

Requisitos: Node 24.20.0 e Docker com Compose. O comando roda em Windows ou Linux;
os clientes PostgreSQL e Restic estão na imagem de ferramentas, sem instalação
global. O download inicial das imagens requer internet. O executor recusa
contextos Docker com endpoint SSH, TCP ou pipe remoto.

```bash
pnpm recovery:drill
```

Alternativa sem instalar dependências JavaScript:

```bash
node --test scripts/recovery/safety.test.mjs
node scripts/recovery-drill.mjs
```

A saída mostra cada etapa e o caminho do relatório sanitizado em
`.cache/recovery-reports/`. Qualquer falha produz código de saída diferente de
zero; sucesso só é registrado depois da conferência de limpeza. A CI executa
o mesmo fluxo no job `recovery-check`.

## Ambiente isolado

- Projeto Compose com UUID próprio e labels que identificam cada recurso.
- Dois clusters PostgreSQL 18.4, sem portas publicadas, em uma rede interna.
- Dados de PostgreSQL e arquivos temporários em `tmpfs`; o único volume
  persistente do ensaio contém o repositório Restic criptografado.
- Ferramentas executadas como usuário `postgres`, filesystem somente leitura
  e capabilities removidas. Não recebem o socket Docker nem diretórios da aplicação.
- Quatro segredos aleatórios de teste: senhas distintas dos dois clusters,
  senha do repositório e senha errada para o caso negativo. Nenhum valor é impresso.
- A pasta privada tem ACL do proprietário/SYSTEM no Windows e modo 0700 no
  Linux. No Linux, os arquivos de segredo têm modo 0444 para leitura pelo usuário
  do container; a pasta 0700 bloqueia o acesso por outros usuários do host.
- O executor passa um arquivo de ambiente vazio ao Compose e apenas variáveis
  de sistema necessárias ao Docker, sem herdar configurações da aplicação.

A limpeza confere projeto e label de execução em containers, rede e volume.
Arquivos locais são removidos individualmente, com lista de nomes permitidos e
checagem de caminho resolvido dentro do workspace. Arquivo desconhecido, diretório
aninhado, symlink ou recurso com identificação divergente interrompe a limpeza.
Não há exclusão recursiva de conteúdo local. Imagens de ferramentas podem
permanecer no cache Docker; não contêm segredos nem dados do ensaio.

## Backup e restauração

1. Aplicar a migração atual de autenticação ao banco de teste e inserir fixtures.
   Criar também tabelas com decimal, JSON, Unicode, instante com fuso, FK, view,
   sequence, proprietário próprio e papéis de leitura com herança e privilégios padrão.
2. Gerar `pg_dump --format=custom --compress=0` do banco inteiro. Falha do processo
   impede a publicação da cópia. Inspecionar o arquivo com `pg_restore --list`.
3. Exportar roles com `pg_dumpall --roles-only --no-role-passwords`, sem hashes
   de senha. Gerar manifesto de formato/versão e checksums SHA-256 dos arquivos.
4. Criar um snapshot Restic com o bundle, criptografado antes de gravar no volume.
   O dump sem criptografia existe somente no `tmpfs` privado do container.
5. Exigir o ID completo do snapshot; não aceitar o seletor mutável `latest`.
   Recusar destino que já contenha o banco, sem executar `DROP`, `--clean` ou
   sobrescrita. Conferir todo o repositório com `restic check --read-data`.
6. Restaurar os arquivos no `tmpfs`, verificar conteúdo com Restic e SHA-256,
   conferir manifesto e formato custom antes de aplicar SQL.
7. Recriar as roles, criar o banco novo e executar
   `pg_restore --exit-on-error --single-transaction`, preservando proprietários e ACLs.
8. Comparar estado e conteúdo com a origem, exercer permissões e constraints,
   testar recusas e remover os recursos do ensaio.

O modo `--no-role-passwords` preserva a necessidade de fornecer credenciais
separadamente: roles recriadas não ganham autenticação por senha. A documentação
[PostgreSQL de pg_dumpall](https://www.postgresql.org/docs/18/app-pg-dumpall.html)
descreve esse comportamento. A senha do administrador de destino é gerada
independentemente e permanece válida após a restauração.

### Administrador inicial do PostgreSQL 18

Os clusters usam o mesmo nome de administrador inicial, `stk_recovery_admin`,
com senhas diferentes. Isso preserva a identidade usada como autora das concessões
de roles. Uma tentativa com nomes diferentes reproduziu a recusa de `GRANTED BY`
documentada na [discussão oficial do PostgreSQL](https://www.postgresql.org/message-id/CA%2BC_kKWHMP4c56jx1BPvP1jmjp2pmBu0Cw07fPVECUmkJSnT4w%40mail.gmail.com).

O script exige exatamente uma linha `CREATE ROLE stk_recovery_admin;` e remove
somente essa criação redundante da cópia de trabalho. Todos os atributos e grants
são reaplicados, com `ON_ERROR_STOP`, sem ignorar erros SQL. O arquivo original
continua protegido no snapshot. A comparação inclui nome do grantor, associação
de roles e opções de herança/administração.

## O que é verificado

- Igualdade dos dados de autenticação e fixtures, incluindo precisão decimal,
  Unicode, JSON e timestamps; hashes são usados para comparação sem imprimir linhas.
- Proprietários de banco, schemas, tabelas, índices e views; ACLs e default privileges.
- Estado da sequence, definições de constraints e grants entre roles.
- Leitura permitida, escrita recusada para leitor, FK efetivamente aplicada e
  privilégios padrão aplicados a uma tabela criada depois da restauração.
- Dump que termina com erro não cria snapshot válido, mesmo após produzir parte do arquivo.
- Senha errada e seletor ambíguo não criam o banco de destino.
- Destino ocupado é recusado e seu estado permanece igual.
- Corrupção deliberada de um pack descartável é detectada pelo Restic.
- Nenhum hash de senha de role foi transferido e nenhum marcador de conteúdo
  privado de teste aparece em texto legível no repositório criptografado.
- Containers, volume, rede e arquivos privados do ensaio são removidos ao final.

`restic check` sem `--read-data` não verifica todos os dados armazenados; o ensaio
usa a leitura completa descrita na
[documentação oficial](https://restic.readthedocs.io/en/stable/045_working_with_repos.html).
Os binários estão fixados por digest em `infra/recovery/Dockerfile` e
`compose.recovery.yml`; Restic 0.19.1 é a versão validada.

## Limites e preparação da operação real

- O dataset é pequeno e fictício. Os tempos medem este ensaio, não o RPO/RTO
  de produção; não incluem provisionar VPS nem buscar cópias remotas.
- `tmpfs` usa RAM e pode estar sujeito a swap do host; este teste não valida
  criptografia de swap. Os limites de memória são próprios do ensaio.
- Não há agendamento, retenção, alertas, R2, autenticação real no banco restaurado,
  anexos, OmniRoute ou verificação de contas financeiras nesta etapa.
- O ambiente fica estático durante a captura de roles e banco. Não se demonstra
  consistência de mudanças concorrentes de DDL/roles entre esses dois comandos.
- O dump preserva sessões e verificações da amostra. Em recuperação real será
  necessário definir revogação de sessões antigas e retomada segura de jobs,
  com workers parados durante a restauração.
- Senhas deste ensaio são descartadas; não constituem uma chave de recuperação
  durável. A custódia externa dessa chave precisa ser preparada antes da ativação real.
- Há tentativa de limpeza em falhas e interrupções normais. Encerramento forçado,
  indisponibilidade do Docker ou divergência de identificação podem deixar recursos;
  nesse caso o comando falha e o relatório identifica o projeto para inspeção.
- Execução na VPS/ARM64, armazenamento externo, retenção e restauração completa
  continuam pendentes. Nenhum comando deste ensaio é um comando de produção.
