# STK-M0-26C — Validação da instalação do runtime e checkout do ensaio

> **STATUS: mutação C executada com exceção documentada.** Nenhum valor de
> secret, hash de secret, identificador de conta R2, conteúdo de
> `deployment.env`, IP administrativo ou caminho privado local aparece neste
> documento. O acesso à VPS foi por SSH com host key previamente conhecida
> (nenhuma host key nova ou alterada aceita), usuário administrativo sem login
> root e elevação por `sudo`; nenhum valor de credencial foi exibido ou
> registrado.

Base: `main` @ `89232c0e7d9a62a27bf293f01c1bf06a4bdc900d` (CI 5/5 success),
issue #77, branch `hermes/m0-26c-install-restore-runtime`.

## 1. Autorização e escopo

Autorização específica do Codex para a mutação C: instalar Node.js 24.20.0
linux-arm64 em `/opt/stakeframe-tools/node`; instalar checkout exato da main em
`/opt/stakeframe` com troca atômica; corrigir owner `root:root` e remover
escrita de grupo/outros; criar `/etc/stakeframe/docker/config.json` privado;
validar runtime, artefatos e acesso anônimo ao manifesto da imagem de
operações; remover somente temporários, staging e rollback criados por esta
execução. A autorização **não** incluía restore, Restic, pull de imagem,
restart/recreate de container, systemd, timer, deploy, migração ou alteração de
credenciais — nada disso foi executado.

## 2. Gates executados antes de qualquer mutação

| #     | Gate                                                                                                                                                                                                      | Resultado |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1     | Worktree limpo; `main` e `origin/main` no SHA autorizado                                                                                                                                                  | OK        |
| 2     | CI da base 5/5 `completed/success`                                                                                                                                                                        | OK        |
| 3     | Identidade SSH validada pelo `known_hosts` existente; nenhuma host key nova/alterada aceita                                                                                                               | OK        |
| 4     | Arquitetura `aarch64`, Linux (Ubuntu 24.04)                                                                                                                                                               | OK        |
| 5     | 5 containers `running/healthy`; RestartCount PostgreSQL 1, demais 0; `OOMKilled=false`                                                                                                                    | OK        |
| 6     | Nenhum container reiniciando                                                                                                                                                                              | OK        |
| 7     | `/opt/stakeframe-tools/node` e `/etc/stakeframe/docker` ausentes; `/opt/stakeframe` diretório real (não symlink, não mountpoint); sem staging/rollback residual                                           | OK        |
| 8     | Espaço livre suficiente em `/opt`, `/etc` e filesystem do Docker (~40 GB, mesmo filesystem)                                                                                                               | OK        |
| 9     | `deployment.env` lido somente dentro do processo, validado sem imprimir valores: imagem fixada por digest, `DEPLOYMENT_ID` presente, conta R2 no formato esperado, bucket e `SECRET_DIRECTORY` conferidos | OK        |
| 10    | 2 secrets de restauração regulares, sem symlink, `root:opc 0640`, tamanhos 32 e 64                                                                                                                        | OK        |
| 11-13 | Probe `docker --config <temporário vazio sob /run> manifest inspect` → `MANIFEST_ACCESS=true` (acesso anônimo; saída descartada; config temporário removido)                                              | OK        |
| 14    | Nenhum gate divergiu → mutação liberada                                                                                                                                                                   | OK        |

## 3. Pacote revisado da main

- `git archive` binário do commit autorizado, gerado fora do repositório.
- Ajuste técnico necessário: geração com `-c core.autocrlf=false`. O
  repositório local usa `core.autocrlf=true`, e o `git archive` inicial
  aplicou conversão CRLF, quebrando a igualdade byte a byte com os blobs
  (detectado na validação de artefatos e corrigido antes de qualquer troca).
- Verificação integral da árvore: 298/298 arquivos com blob-id idêntico aos
  blobs da main (`sha1("blob <tamanho>\\0" + conteúdo)`).
- Transferência por stdin de SSH autenticado para caminho imprevisível em
  `/run` (diretório `0700`, arquivo `0600`), sem intermediários locais
  persistentes; SHA-256 local/remoto comparados dentro dos processos →
  `ARCHIVE_MATCH=true` (valor não registrado).
- Tar validado antes da extração: 344 entradas; nenhuma entrada absoluta,
  nenhum `..`, nenhum `.git/`, `.env`, `.env.local`, nenhum arquivo com nome ou
  extensão de segredo.
- Extração somente em staging novo sob `/opt` (mesmo filesystem da troca
  atômica).

## 4. Node.js

- Origem oficial `nodejs.org/dist/v24.20.0` (`linux-arm64.tar.xz`) +
  `SHASUMS256.txt` oficial; hash calculado = publicado = autorizado
  `5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7` (valor
  público oficial).
- Tar validado contra caminhos absolutos e `..`; extração em staging próprio
  sob `/opt/stakeframe-tools`; `root:root`; diretórios `0755`; arquivos `0644`
  com executáveis upstream mantidos `0755`; renome atômico para
  `/opt/stakeframe-tools/node`.
- Validação: `node --version` → `v24.20.0`; `process.platform` → `linux`;
  `process.arch` → `arm64`; binário regular sem symlink; árvore sem entradas
  graváveis por grupo/outros.
- Nenhum symlink em `/usr/bin`, nenhuma alteração de PATH global, nenhum
  pacote global. Tarball e staging do download removidos.

## 5. Checkout da main em `/opt/stakeframe`

Staging root-owned validado antes da troca:

- 298 arquivos `0644` (a main não define nenhum modo `100755`; bits de
  execução preservados exatamente como no git); diretórios `0755`.
- Symlinks: 0. Graváveis por grupo/outros: 0. Owner: `root:root`.
- `.stakeframe-revision` `0444` contendo somente o SHA autorizado.
- Artefatos de restore com hash idêntico aos blobs da main (6 paths
  conferidos); `node --check scripts/restore-rehearsal.mjs` → pass.

Troca: renome do `/opt/stakeframe` anterior para rollback com UUID e renome
imediato do staging validado para `/opt/stakeframe`. Nenhum container foi
reiniciado ou recriado.

A validação pós-troca detectou divergência no gate de conteúdo do bind do
PostgreSQL (seção 6) e o **rollback automático prescrito foi executado**: nova
árvore movida para quarentena, árvore anterior restaurada atomicamente em
`/opt/stakeframe`, containers verificados `running/healthy` em seguida.

## 6. Gate do bind — causa da interrupção

- O compose de produção faz bind de **arquivo único** do PostgreSQL:
  `/opt/stakeframe/infra/production/init-app-role.sh` →
  `/docker-entrypoint-initdb.d/10-app-role.sh:ro`. Bind de arquivo fixa o
  inode: após o renome do diretório, o container continuaria lendo o inode
  antigo (mesmo conteúdo, inode diferente). A visualização do novo arquivo
  exigiria recreate do container — não autorizado.
- Caracterização da divergência: o conteúdo entregue ao container é o mesmo
  script da main com terminações CRLF (29 bytes `CR`; removendo-os, o hash
  torna-se idêntico ao blob da main
  `0e9e1459ec4ead6900f41a4bddad23ec63bd5211111f886be380e205219672d3`). A
  árvore implantada atual (290 arquivos,
  subconjunto da main, **sem nenhum arquivo extra**) antecede as entregas
  recentes e carrega EOL Windows pré-existente. A divergência é apenas de EOL;
  não há indício de conteúdo divergente.
- Decisão: seguido o prescrito — falha de validação pós-troca → rollback →
  interrupção → reporte ao Codex. O gate byte a byte funcionou como projetado.

## 7. Item 3 da autorização na árvore vigente

Aplicado à árvore restaurada (sem alteração de conteúdo):

| Métrica                 | Antes       | Depois                                   |
| ----------------------- | ----------- | ---------------------------------------- |
| Entradas world-writable | 336         | 0                                        |
| Owner                   | `root:root` | `root:root` (verificado 0 entradas fora) |
| Diretórios              | mistos      | `0755`                                   |
| Arquivos                | `0666`      | `0644`                                   |

O hash do conteúdo entregue ao bind foi conferido **antes e depois** da
correção: inalterado; bind legível; nenhum container afetado.

## 8. Docker config privado

- `/etc/stakeframe/docker`: diretório `root:root 0700`.
- `/etc/stakeframe/docker/config.json`: arquivo regular, sem symlink,
  `root:root 0600`, conteúdo exato `{"auths":{}}` (12 bytes).
- Nada foi copiado de config existente, token, credencial administrativa ou
  auth de registry.
- Validação com essa configuração (saída descartada):
  `MANIFEST_ACCESS=true`.

## 9. Validações pós-instalação (estado final)

| #   | Item                                                                                               | Resultado                                                                                    |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | `/opt/stakeframe-tools/node/bin/node` v24.20.0 / linux / arm64                                     | OK                                                                                           |
| 2   | `.stakeframe-revision` com o SHA autorizado, modo `0444`                                           | Validado no staging e na árvore trocada; **não vigente** após o rollback da seção 6          |
| 3   | `/opt/stakeframe` e `/opt/stakeframe-tools` sem escrita por grupo/outros                           | OK                                                                                           |
| 4   | Artefatos de restore coincidem com a main                                                          | OK no staging e na árvore trocada; na árvore vigente, conteúdo idêntico módulo EOL (seção 6) |
| 5-7 | `/etc/stakeframe/docker` `0700`; `config.json` regular, sem symlink, `0600`, somente `auths` vazio | OK                                                                                           |
| 8   | `MANIFEST_ACCESS=true`                                                                             | OK                                                                                           |
| 9   | `deployment.env` e os 18 secrets inalterados                                                       | OK (estat antes/depois)                                                                      |
| 10  | 5 containers `running/healthy`                                                                     | OK                                                                                           |
| 11  | RestartCount e OOMKilled idênticos à baseline                                                      | OK                                                                                           |
| 12  | Nenhum container reiniciado, recriado ou removido                                                  | OK (`StartedAt` idênticos antes/depois)                                                      |
| 13  | Zero containers/volumes/redes com label `io.stakeframe.restore`                                    | OK (0/0/0)                                                                                   |
| 14  | Zero units ou timers de restore                                                                    | OK                                                                                           |
| 15  | Zero processos de restore ou Restic                                                                | OK (recheck sem auto-match do argv)                                                          |
| 16  | Zero staging, archive ou rollback residual (`/opt`, `/run`, `/tmp`)                                | OK                                                                                           |

## 10. Cleanup e rollback

- Rollback executado automaticamente (seção 5/6) e verificado: árvore anterior
  restaurada, containers healthy.
- Removidos somente artefatos desta execução, sempre após conferir caminho sob
  `/opt`, prefixo esperado, não-symlink e não-mountpoint: 2 stagings, payload
  em `/run`, quarentena, rollback, tarballs, configs temporárias de probe e
  arquivos de diff em `/tmp`. Resíduo final: 0.
- Nenhuma exclusão fora do escopo autorizado.

## 11. Limitações e próximos passos

- **Checkout revisado NÃO está implantado** — o rollback prescrito reverteu a
  troca após a divergência de EOL no bind (seção 6). Node, hardening de
  permissões e Docker config **estão** instalados e validados.
- Para concluir a implantação do checkout será necessária decisão do Codex,
  porque o bind de arquivo único só reflete o novo conteúdo após recreate do
  container: ou reexecutar a troca em janela que autorize o recreate (por
  exemplo imediatamente antes da janela D, que já envolve containers de
  restore), ou aceitar explicitamente que o container continuará vendo o
  conteúdo antigo (idêntico módulo EOL) até o recreate.
- Mutações D (primeiro restore isolado) e E (timer mensal) continuam pendentes
  de autorização própria.
- Nenhum merge foi executado; a PR fica aguardando revisão documental do
  Codex.

## 12. Rastro

- Issue #77; branch `hermes/m0-26c-install-restore-runtime` (base
  `89232c0e7d9a62a27bf293f01c1bf06a4bdc900d`); diff documental restrito a este
  documento e a `docs/M0-26-PREFLIGHT.md`; verificações locais: Prettier
  direcionado, `git diff --check` e validação de links.
