# STK-M0-32 — Remoção controlada do rollback do checkout (STK-M0-29)

- **Base:** `main` = `8c02c06ac4eb966619a4c004a23e5ebe76472016`
- **Issue:** [#89](https://github.com/RhianB14/stakeframe/issues/89)
- **Data da operação:** 10/09/2026
- **Natureza:** mutação **destrutiva de um único diretório**, precedida de três
  fases de leitura e seguida de pós-validação completa.

## 1. Autorização e escopo

Autorização explícita do proprietário, **retransmitida**: exclusão destrutiva de
**um único** diretório — o rollback privado do checkout criado e retido pela
STK-M0-29, revisão `d00717f383420753dace164bcefa489ca33af48d`. Nenhum outro
diretório, staging, bundle, journal, archive ou recurso foi autorizado.

O caminho, o inode e qualquer evidência identificadora privada **não** são
publicados neste documento.

## 2. Gates locais e GitHub (antes de acessar a VPS)

| Gate                                              | Resultado |
| ------------------------------------------------- | --------- |
| `origin/main` exatamente igual à base obrigatória | ✅        |
| cinco checks `completed/success` no SHA exato     | ✅        |
| worktree principal limpo                          | ✅        |
| issue #11 `closed/completed` e PR #88 `merged`    | ✅        |
| nenhuma operação Git pendente fora do escopo      | ✅        |

## 3. Preflight na VPS (estritamente somente leitura)

| Verificação                                                      | Resultado                                  |
| ---------------------------------------------------------------- | ------------------------------------------ |
| mesmo guest esperado; `sudo -n id -u` = 0                        | ✅                                         |
| checkout ativo em `/opt/stakeframe`, diretório real              | ✅ não symlink, não mountpoint             |
| revisão ativa                                                    | `36c0e6386fb4cc47cb899e32ae70fc25877f043f` |
| inventário do checkout ativo                                     | 304 arquivos                               |
| `ipv6_guard.py` (artefato operacional)                           | `63b0ce735a73e352…` (inalterado)           |
| `stakeframe-restore.service` / `.timer`                          | `6dc2e66f48305e95…` / `8759cf4897b7ec5a…`  |
| produção                                                         | 5/5 `running/healthy`, sem `OOM`           |
| `StartedAt`, `RestartCount` e `OOMKilled`                        | idênticos à baseline                       |
| backup                                                           | `state=ready`, dentro do RPO               |
| restore mensal                                                   | sem execução ativa                         |
| `stakeframe-restore.timer`                                       | `enabled/active/waiting`                   |
| processos concorrentes de backup/prune/restore/deploy/manutenção | 0                                          |
| disco                                                            | 40 GiB livres, 17% usados                  |

## 4. Identidade do alvo autorizado

Exatamente **um** candidato correspondente, e nenhuma ambiguidade:

| Propriedade                                                                                                                                                                          | Observado                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| posição                                                                                                                                                                              | filho direto de `/opt`, distinto do checkout                   |
| tipo                                                                                                                                                                                 | diretório real; não symlink; não mountpoint; 0 submounts       |
| filesystem                                                                                                                                                                           | o mesmo de `/opt` e do checkout ativo                          |
| owner / modo                                                                                                                                                                         | `root:root` / `0755`                                           |
| `.stakeframe-revision`                                                                                                                                                               | `d00717f383420753dace164bcefa489ca33af48d` (modo `0444`)       |
| inventário                                                                                                                                                                           | 300 arquivos, 47 diretórios                                    |
| tamanho                                                                                                                                                                              | 2.561.980 bytes aparentes; 3.448.832 bytes alocados (~3,3 MiB) |
| diretórios / arquivos da árvore                                                                                                                                                      | 47 × `0755`; 299 × `0644` + 1 × `0444`                         |
| gravável por grupo/outros                                                                                                                                                            | 0 diretórios, 0 arquivos                                       |
| arquivos especiais, sockets, devices ou FIFOs                                                                                                                                        | 0                                                              |
| symlinks internos                                                                                                                                                                    | 0                                                              |
| referências ativas (mountinfo, findmnt, fstab, `mount`, Docker/containers, processos, descritores abertos, `cwd` de processos, units systemd, configuração ativa, symlinks externos) | 0                                                              |

**Sobre o modo `0755`.** A árvore do rollback é uma **árvore de checkout**: segue
a mesma convenção do checkout ativo — diretórios `0755`, arquivos conforme os
modos do Git, `.stakeframe-revision` em `0444`, `root:root` em toda a árvore,
zero gravável por grupo/outros
([M0-26C2-VALIDATION.md](M0-26C2-VALIDATION.md) §4). A menção a `0700` em
[M0-30-VALIDATION.md](M0-30-VALIDATION.md) §1 descreve os diretórios de
**runtime/estado** do restore (`restore-reports`, `RuntimeDirectory`), não o
rollback do checkout. Não havia registro anterior que atribuísse `0700` a este
diretório; o valor observado é coerente com a classe do objeto.

## 5. Exclusão controlada

Imediatamente antes da mutação, a identidade foi **relida** (lstat, `dev`,
`inode`, proprietário, modo, revisão, 300 arquivos), o checkout ativo foi
reconferido (identidade distinta, revisão correta, 304 arquivos) e produção,
backup e ausência de concorrência foram reconfirmados.

Sequência executada:

1. quarentena privada e imprevisível gerada como filho direto de `/opt`, no
   mesmo filesystem;
2. confirmado que o nome de quarentena **não** existia;
3. **rename atômico** apenas do candidato autorizado;
4. quarentena relida: `dev` e `inode` **idênticos** aos do alvo autorizado;
5. caminho original confirmado **ausente** e checkout ativo reconferido (mesmo
   inode, mesma revisão, 304 arquivos);
6. quarentena com **0 submounts** reconfirmada antes da remoção;
7. remoção **apenas** da quarentena — sem glob, sem prefixo amplo, sem `find`
   com múltiplos resultados e sem variável vazia;
8. ausência relida: caminho original **ausente**, quarentena **ausente**.

Nenhuma etapa disparou restauração automática de nome, porque a validação pós-rename
passou integralmente.

## 6. Inventário antes/depois

| Item                     | Antes                     | Depois                        |
| ------------------------ | ------------------------- | ----------------------------- |
| filhos diretos de `/opt` | 5 (incluindo o rollback)  | **4**                         |
| arquivos no alvo         | 300 (2.561.980 B)         | removido                      |
| quarentenas residuais    | 0                         | **0**                         |
| checkout ativo           | 304 arquivos, `36c0e638…` | **304 arquivos, `36c0e638…`** |

## 7. Pós-validação

| Verificação                                                                                                                 | Resultado                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| rollback autorizado ausente; zero quarentena residual                                                                       | ✅                                                                                                                                      |
| checkout ativo: mesma identidade (inode) e mesma revisão                                                                    | ✅                                                                                                                                      |
| artefatos operacionais ativos com hashes inalterados                                                                        | ✅                                                                                                                                      |
| produção 5/5 `running/healthy`; baseline inalterada                                                                         | ✅                                                                                                                                      |
| backup                                                                                                                      | `state=ready`                                                                                                                           |
| `stakeframe-restore.timer`                                                                                                  | `enabled/active/waiting`                                                                                                                |
| `stakeframe-restore.service`                                                                                                | `inactive/dead`, `Result=success`, `ExecMainStatus=0`                                                                                   |
| restore disparado                                                                                                           | **nenhum** (journal do timer sem entradas no período)                                                                                   |
| firewall IPv6 e run confirmado da STK-M0-23                                                                                 | intocados: INPUT/FORWARD `DROP`, OUTPUT `ACCEPT`, **1 chain própria `STK6_*`** preservada, com salto de `INPUT` e as 5 regras aprovadas |
| recursos IPv6 preservados (`active.json`, dois diretórios de run, journals, unit files, archive legado arquivado, stagings) | ✅                                                                                                                                      |
| outros arquivos ou diretórios removidos                                                                                     | **nenhum**                                                                                                                              |

Recursos IPv6 conferidos por contagem, sem publicar caminhos: `active.json`
presente; dois diretórios de run com 52 arquivos; 2 journals; 2 unit files em
`/run/systemd/system` com `LoadState=loaded` e `ActiveState=inactive`;
`stk-ipv6-staging-m0-06` e `stk-ipv6-staging-m0-23` presentes.

Contagens do firewall IPv6 obtidas **separadamente**, somente em leitura:

| Contagem                                 | Valor |
| ---------------------------------------- | ----- |
| declarações de chain com prefixo `STK6_` | **1** |
| saltos de `INPUT` para a chain própria   | **1** |
| regras dentro da chain própria           | **5** |
| ocorrências totais da string `STK6_`     | **7** |

O número antes publicado como quantidade de chains `STK6_*` correspondia, na
verdade, à **contagem de linhas que contêm a string** — 1 declaração + 1 salto +
5 regras. A chain é **uma só**. As 5 regras internas são loopback, `RELATED,ESTABLISHED`, ICMPv6,
`TCP/22 NEW` e `DROP`. As políticas permanecem `INPUT`/`FORWARD` `DROP` e
`OUTPUT` `ACCEPT`. O arquivo de persistência não contém declaração da chain,
coerente com a persistência deliberadamente fora de escopo naquela janela.

## 8. Limitações

- A remoção é **irreversível**: o rollback do checkout não existe mais no
  servidor. Não foi mantida cópia própria deste diretório.
- Não foi verificada a existência de cópias externas do bundle de rollback; a
  afirmação de ausência vale para o servidor.
- A contagem de recursos IPv6 é agregada aos dois runs (confirmado e legado
  arquivado) e não distingue arquivo a arquivo.
- Nenhum hash de conteúdo interno do rollback, caminho, inode, host, IP,
  usuário ou evidência bruta foi publicado.
- A execução foi acompanhada por leitura somente; a conferência do próprio
  trabalho não é apresentada como revisão independente do GitHub.

## 9. Referências

- [M0-29-VALIDATION.md](M0-29-VALIDATION.md) — criação e retenção do rollback.
- [M0-30-VALIDATION.md](M0-30-VALIDATION.md) — preservação do rollback na
  janela do timer.
- [M0-31-VALIDATION.md](M0-31-VALIDATION.md) — reconciliação que **não** o
  removeu.
- [M0-CHECKLIST.md](M0-CHECKLIST.md) — narrativa do M0.
