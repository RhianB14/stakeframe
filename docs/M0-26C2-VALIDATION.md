# STK-M0-26C2 — Validação da conclusão do checkout revisado

> **STATUS: checkout exato implantado conforme a autorização, com exceção temporária do bind registrada.** Nenhum valor de secret,
> hash de secret, identificador de conta R2, conteúdo de `deployment.env`, IP
> administrativo ou caminho privado local aparece neste documento. O acesso à
> VPS foi por SSH com host key previamente conhecida (nenhuma host key nova ou
> alterada aceita), usuário administrativo sem login root e elevação por
> `sudo`; nenhum valor de credencial foi exibido ou registrado.

Base: `main` @ `d00717f383420753dace164bcefa489ca33af48d` (CI 5/5 success),
issue #77, branch `hermes/m0-26c2-complete-checkout`.

## 1. Autorização e escopo

Autorização específica do Codex (STK-M0-26C2) para concluir a pendência da
issue #77: instalar em `/opt/stakeframe` um checkout byte a byte idêntico à
`main` @ `d00717f383420753dace164bcefa489ca33af48d`, com troca atômica e sem
reiniciar, recriar ou remover containers. A autorização aceitou
explicitamente que o bind de arquivo único do PostgreSQL continue apontando
temporariamente para o inode anterior, condicionado a: arquivo novo idêntico
ao blob da `main`; arquivo visto pelo container inalterado; única diferença
CRLF versus LF; normalização CRLF→LF idêntica ao blob; banco já inicializado
e script não em execução; container PostgreSQL saudável e sem mudança de
`RestartCount`, `OOMKilled` ou `StartedAt`. A autorização **não** incluía
merge, restart/stop/recreate de container, alteração do arquivo preso ao
inode antigo, restore ou Restic, pull/execução de imagem, systemd, deploy,
migração, alteração de credenciais ou exclusão fora dos temporários criados
por esta execução — nada disso foi executado.

## 2. Gates executados antes de qualquer mutação

| #     | Gate                                                                                                                                                                                                                                                          | Resultado |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1     | Worktree limpo (repositório e worktree dedicado)                                                                                                                                                                                                              | OK        |
| 2     | `fetch` + `main`, `origin/main`, base da branch e `refs/heads/main` remoto exatamente em `d00717f383420753dace164bcefa489ca33af48d`                                                                                                                           | OK        |
| 3     | CI da base 5/5 `completed/success` (application-check, application-arm64-check, format-check, network-security-simulation, recovery-check)                                                                                                                    | OK        |
| 4     | Identidade SSH validada pelo `known_hosts` existente; nenhuma host key nova/alterada aceita                                                                                                                                                                   | OK        |
| 5     | Host Linux `aarch64`                                                                                                                                                                                                                                          | OK        |
| 6     | Baseline sanitizada dos 5 containers: `running/healthy`, `RestartCount` (PostgreSQL 1, demais 0), `OOMKilled=false`, `StartedAt` registrados                                                                                                                  | OK        |
| 7     | Nenhum container insaudável, reiniciando ou divergente da baseline conhecida                                                                                                                                                                                  | OK        |
| 8     | `/opt/stakeframe`: diretório real, não symlink, não mountpoint, filesystem local (não overlay), sem staging/rollback/quarentena residual                                                                                                                      | OK        |
| 9-10  | Inventário de mounts cuja origem está sob `/opt/stakeframe`: único mount afetado é o bind documentado `infra/production/init-app-role.sh` → `/docker-entrypoint-initdb.d/10-app-role.sh:ro` no container PostgreSQL                                           | OK        |
| 11    | PostgreSQL com volume de dados inicializado (`PG_VERSION` presente no `PGDATA` do container) e nenhum processo `init-app-role.sh` em execução                                                                                                                 | OK        |
| 12-13 | Hashes sem publicar conteúdo: host e container com o mesmo conteúdo (29 bytes CR em ambos); após conversão exclusiva CRLF→LF, ambos idênticos ao blob da `main` (`0e9e1459ec4ead6900f41a4bddad23ec63bd5211111f886be380e205219672d3`); nenhuma outra diferença | OK        |
| 14    | Espaço livre suficiente no filesystem de `/opt` (~41 GB disponíveis)                                                                                                                                                                                          | OK        |
| 15    | Node 24.20.0 em `/opt/stakeframe-tools/node` e `/etc/stakeframe/docker/config.json` íntegros e inalterados (dir `0700`, arquivo `0600`)                                                                                                                       | OK        |
| 16    | `deployment.env`, secrets, tokens e credenciais nunca lidos ou impressos (apenas validação em-processo e metadados)                                                                                                                                           | OK        |

## 3. Pacote revisado da `main`

1. `git -c core.autocrlf=false archive` binário do commit autorizado, gerado a
   partir do repositório local (sem cópia do worktree Windows).
2. Validação integral local: 299 arquivos tracked, todos byte a byte idênticos
   aos blobs correspondentes (SHA-256 por arquivo), nenhum arquivo extra,
   nenhum caminho absoluto, nenhum componente `..`, nenhum `.git`/`.env` real
   (apenas os templates `*.example` rastreados no próprio commit), nenhum
   symlink.
3. Transferência por stdin sobre SSH para diretório imprevisível sob `/run`
   (`0700`), arquivo com `0600`; SHA-256 comparado dentro dos processos:
   `TRANSFER_ARCHIVE_MATCH=true`.
4. Manifesto SHA-256 da árvore transferido separadamente para validação na VPS.

## 4. Staging

Extração em staging novo sob `/opt` (mesmo filesystem de `/opt/stakeframe`) e
validação:

- tar sadio: 299 entradas de arquivo, 0 ausentes, 0 extras, sem caminhos
  absolutos ou `..`;
- 299/299 arquivos com SHA-256 idêntico ao manifesto (blobs da `main`);
- `.stakeframe-revision` regular, `root:root`, modo `0444`, contendo somente
  `d00717f383420753dace164bcefa489ca33af48d`;
- owner `root:root`, diretórios `0755`, arquivos conforme os modos do Git
  (`0644`), zero entradas graváveis por grupo/outros;
- artefatos de restore idênticos aos blobs
  (`scripts/restore-rehearsal.mjs`, `scripts/deployment-rehearsal.mjs`);
- `node --check scripts/restore-rehearsal.mjs` aprovado com o Node já
  instalado;
- zero arquivos extras além de `.stakeframe-revision`; zero symlinks.

Resultado: `STAGE_OK`.

## 5. Troca atômica autorizada

1. Nomes imprevisíveis gerados de `/dev/urandom` para rollback, sob `/opt`.
2. Captura pré-troca: hash do bind no host (`3b44c8d30d47a29f…`, CRLF), inode
   do bind, contagem de arquivos da árvore vigente (290), hash do arquivo visto
   dentro do container (idêntico ao do host), baseline de containers.
3. `mv /opt/stakeframe → rollback` e imediatamente `mv staging →
/opt/stakeframe` (renames atômicos no mesmo filesystem).
4. Verificação imediata: `.stakeframe-revision` correto; inode do bind na nova
   árvore diferente do anterior (esperado); arquivo visto dentro do container
   com o mesmo hash da baseline (inode antigo mantido, 29 bytes CR); árvore de
   rollback intacta (mesmo hash no bind, 290 arquivos); 300 arquivos na nova
   árvore.
5. Nenhum container reiniciado, recriado, parado ou removido; `docker ps -a`
   inalterado.

Resultado: `SWAP_OK`.

## 6. Validações após a troca

| #   | Validação                                                                                                                                                              | Resultado |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | `.stakeframe-revision` com o SHA autorizado, `root:root 0444`                                                                                                          | OK        |
| 2   | 299/299 arquivos tracked byte a byte idênticos à `main` (SHA-256 por arquivo)                                                                                          | OK        |
| 3   | Zero arquivos tracked ausentes; zero extras, exceto `.stakeframe-revision`                                                                                             | OK        |
| 4   | Owner `root:root` em toda a árvore; diretórios `0755`; arquivos `0644`; zero graváveis por grupo/outros                                                                | OK        |
| 5   | Arquivo novo no host exatamente igual ao blob LF da `main` (`0e9e1459ec4ead69…`)                                                                                       | OK        |
| 6   | Arquivo visto dentro do PostgreSQL: hash da baseline mantido, legível, difere do blob novo somente por CRLF (29 bytes CR) e normaliza exatamente para o blob da `main` | OK        |
| 7   | Nenhum processo de inicialização executando o script                                                                                                                   | OK        |
| 8   | 5 containers `running/healthy`                                                                                                                                         | OK        |
| 9   | `RestartCount`, `OOMKilled` e `StartedAt` idênticos à baseline pré-troca                                                                                               | OK        |
| 10  | Nenhum container reiniciado, recriado, removido ou iniciado (`docker ps -a` inalterado)                                                                                | OK        |
| 11  | Node v24.20.0 íntegro (`root:root`)                                                                                                                                    | OK        |
| 12  | Docker config privado íntegro; `MANIFEST_ACCESS=true` com config temporário sob `/run`, saída descartada e config removido                                             | OK        |
| 13  | Zero recursos de restore: containers, volumes, redes, processos (com exclusão dos matches do próprio diagnóstico), units e timers                                      | OK        |
| 14  | `deployment.env` (`root:root 0600`) e secrets inalterados por metadados sanitizados (proprietário, modo, tamanho), sem ler valores                                     | OK        |

Resultado: `ALL_POST_SWAP_OK` — rollback não foi necessário.

## 7. Rollback

Não acionado: todas as validações pós-troca passaram antes da remoção do
rollback. O diretório de rollback permaneceu intacto até o cleanup.

## 8. Cleanup

Executado somente após todas as validações:

- remoção do diretório de rollback desta execução (290 arquivos), após
  verificação de prefixo `/opt/.m0-26c2-rollback.`, ausência de symlink e de
  mountpoint;
- remoção do payload/staging sob `/run` desta execução, com as mesmas
  verificações de prefixo e natureza;
- confirmação de zero resíduos em `/opt`, `/run` e `/tmp`;
- nenhum caminho preexistente removido.

Resultado: `CLEANUP_AND_SNAPSHOT_OK`.

## 9. Estado final da VPS

- `/opt/stakeframe`: checkout exato da `main` @ `d00717f383420753dace164bcefa489ca33af48d`
  (300 arquivos incluindo `.stakeframe-revision`, 46 diretórios), `root:root`,
  diretórios `0755`, arquivos `0644`, zero graváveis por grupo/outros.
- `/opt/stakeframe/.stakeframe-revision`: `root:root 0444` com o SHA autorizado.
- Bind do PostgreSQL no host: blob LF da `main`; dentro do container: inode
  anterior mantido (conteúdo CRLF, mesmo hash da baseline, normaliza
  exatamente para o blob da `main`) — aceite explícito da autorização; uma
  futura recriação autorizada fará o container montar o arquivo do checkout
  novo.
- Node v24.20.0 e `/etc/stakeframe/docker/config.json` íntegros, inalterados.
- 5 containers `running/healthy`, `Up 27-31 h`, sem reinício; `RestartCount`
  e `OOMKilled` inalterados.
- Zero recursos de restore; zero resíduos; secrets e `deployment.env`
  inalterados.

## 10. Limitações restantes

1. O container PostgreSQL continua vendo o inode antigo do bind (CRLF) até uma
   recriação/reinicialização autorizada; o conteúdo é funcionalmente idêntico
   (diferença exclusiva de EOL) e o script não é reexecutado automaticamente.
2. Mutações D (primeiro restore isolado) e E (timer mensal) continuam pendentes
   de autorização própria.
3. O fechamento da issue #77 pela PR desta execução depende do merge
   documental autorizado pelo Codex.
