# STK-M0-26B — Validação da instalação da credencial R2 de restauração

> **STATUS: execução concluída.** Esta validação registra somente metadados e
> resultados booleanos. Nenhum valor de credencial, hash de credencial,
> identificador de conta ou caminho de fonte privada é registrado.
>
> A mutação B foi executada na VPS sob autorização específica: instalação das
> chaves S3 da credencial lógica existente `stakeframe-backups-reader-prod`.
> A mutação A já havia sido concluída na STK-M0-21; nenhum token novo foi
> criado nesta execução. O escopo conhecido é **Object Read only**, restrito ao
> bucket `stakeframe-backups`, com leitura e listagem de objetos, sem escrita,
> exclusão ou administração.

## 1. Base, issue e escopo

- Base obrigatória conferida antes da execução: `main` em
  `0f3fd75a5ce049bebf7648cb72e38396e4f34731`; CI da base: 5/5 success.
- Issue: STK-M0-26B — Instalar credencial R2 de restauração na VPS.
- VPS: identidade validada contra a entrada existente em `known_hosts`; nenhuma
  chave de host nova ou alterada foi aceita.
- Operações permitidas usadas: inspeções read-only, transferência das duas
  chaves por stdin autenticado, criação atômica dos dois arquivos, definição de
  owner/mode e verificação pós-instalação.
- Fora do escopo: criação de token, operações de escrita no R2, Restic, restore,
  deploy, migração, instalação de Node, checkout, systemd, timer ou restart de
  containers.

## 2. Gates anteriores à mutação

Todos os gates foram aprovados antes da transferência:

| Gate                            | Resultado sanitizado                                                      |
| ------------------------------- | ------------------------------------------------------------------------- |
| `main` local e `origin/main`    | `0f3fd75a5ce049bebf7648cb72e38396e4f34731`; worktree limpo                |
| Identidade SSH                  | host key apresentada coincide com a entrada preexistente em `known_hosts` |
| `/etc/stakeframe/secrets`       | diretório regular, `root:root`, `0700`, sem symlink                       |
| Grupo `opc`                     | presente                                                                  |
| Destinos antes da execução      | ambos ausentes, sem symlink                                               |
| Fonte local `access_key_id`     | arquivo regular, sem symlink, 32 hex após CR/LF final                     |
| Fonte local `secret_access_key` | arquivo regular, sem symlink, 64 hex após CR/LF final                     |
| ACL da fonte local              | somente proprietário e SYSTEM; nenhum valor foi impresso ou copiado       |

## 3. Procedimento executado

- Os dois valores foram enviados somente pelo stdin de um processo SSH já
  autenticado; não foram usados em argumentos, variáveis persistentes, arquivos
  intermediários, histórico, logs ou output.
- O processo remoto usou `umask 077`, temporários imprevisíveis dentro de
  `/etc/stakeframe/secrets`, validação hexadecimal e de comprimento, `chown
root:opc`, `chmod 0640` e `mv -T` atômico para cada destino.
- A rotina tinha trap de rollback: em falha após a criação de um destino,
  removeria somente os destinos criados por esta execução e os temporários.
- Nenhum comando Restic, Docker de restore, deploy, migração, systemd ou timer
  foi executado.

## 4. Resultado pós-instalação

| Destino                        | Tipo            | Symlink | Owner      | Mode   | Tamanho normalizado | Comparação   |
| ------------------------------ | --------------- | ------- | ---------- | ------ | ------------------: | ------------ |
| `r2_backup_restore_access_key` | arquivo regular | não     | `root:opc` | `0640` |                  32 | `MATCH=true` |
| `r2_backup_restore_secret_key` | arquivo regular | não     | `root:opc` | `0640` |                  64 | `MATCH=true` |

As comparações foram feitas por hash dentro dos processos local/remoto; os
hashes não foram registrados nem retornados.

## 5. Integridade da produção

### Containers

Estado sanitizado imediatamente antes e depois da mutação:

| Container                            | Antes                                            | Depois |
| ------------------------------------ | ------------------------------------------------ | ------ |
| `stakeframe-production-postgres-1`   | `running/healthy`, RestartCount `1`, OOM `false` | igual  |
| `stakeframe-production-api-1`        | `running/healthy`, RestartCount `0`, OOM `false` | igual  |
| `stakeframe-production-worker-1`     | `running/healthy`, RestartCount `0`, OOM `false` | igual  |
| `stakeframe-production-operations-1` | `running/healthy`, RestartCount `0`, OOM `false` | igual  |
| `stakeframe-production-web-1`        | `running/healthy`, RestartCount `0`, OOM `false` | igual  |

Nenhum container foi reiniciado, recriado ou removido.

### Dezesseis segredos anteriores

Os 16 arquivos anteriores permaneceram regulares, sem symlink, com os mesmos
owners, modos e tamanhos observados antes da mutação:

- 15 arquivos: `opc:opc`, `0640`, tamanhos sanitizados preservados;
- `postgres_password`: `root:root`, `0600`, tamanho sanitizado preservado.

Nenhum conteúdo foi lido para registro e nenhum valor foi alterado.

## 6. Rollback, R2 e limitações

- Rollback: **não necessário**; os dois destinos foram instalados e verificados.
- R2: nenhuma escrita, exclusão, administração, Restic ou operação de lock foi
  executada nesta tarefa.
- A validação confirma a instalação e a correspondência das duas chaves, mas não
  executa `restic`, restore ou ensaio. A capacidade operacional de leitura será
  exercida somente na janela D, após as autorizações próprias de C e D.
- As mutações C, D e E continuam pendentes: Node/checkout/configuração, primeiro
  restore isolado e timer mensal.

## 7. Repositório e evidências

- Documentação desta execução: este arquivo e a atualização de
  `docs/M0-26-PREFLIGHT.md`.
- Nenhum segredo, hash, identificador de conta ou caminho privado local entra no
  repositório, issue, PR ou logs.
