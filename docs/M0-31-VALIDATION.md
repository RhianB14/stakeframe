# STK-M0-31 — Reconciliação da janela IPv6 executada

> **STATUS: JANELA IPv6 CONFIRMADA NA VPS EM 07/09/2026.** A aplicação do delta
> IPv6 deixou de ser pendente. Esta tarefa é **exclusivamente documental**:
> reconcilia os documentos que ainda descreviam a aplicação como futura e
> registra o preflight de 10/09/2026, que abortou antes de qualquer mutação por
> premissa vencida.

Issue: [#11](https://github.com/RhianB14/stakeframe/issues/11). Comentário
operacional do aborto: [issue #11 (comment)](https://github.com/RhianB14/stakeframe/issues/11#issuecomment-5618017312).
Base revisada: `9a1c82d649f70161e8e3abcc63a70bddbc648394`, com os cinco checks
obrigatórios `completed/success`.

## 1. Acontecimentos distintos (não equivalentes)

| Acontecimento                             | Quando         | Natureza                                                                              |
| ----------------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| Primeira janela (STK-M0-06)               | 06/09/2026     | apply do delta, confirmação recusada, fase `rollback_incomplete`; firewall restaurado |
| Encerramento administrativo do run legado | 07/09/2026     | units residuais removidas e apontador arquivado, sob autorização própria (STK-M0-22)  |
| **Janela IPv6 real (STK-M0-23)**          | **07/09/2026** | **apply e confirm concluídos; delta ativo, não revertido**                            |
| Preflight de reconciliação (STK-M0-31)    | 10/09/2026     | somente leitura; interrompido por divergência, sem mutação                            |
| Rollback do checkout (STK-M0-29)          | 09/09/2026     | retido no servidor; exclusão exige autorização separada                               |

Nenhum desses acontecimentos equivale a outro. O encerramento administrativo do
run legado resolveu o apontador residual e **não** aplicou hardening; a tentativa
de 10/09 **não** executou prepare, apply nem confirm.

## 2. Run confirmado

- run: `53a5b43c1bd6049fe497`
- fase terminal: `confirmed`
- `rollback_actions`: `[]` — nenhuma ação de rollback foi aplicada
- `authorization_ref`: `user-confirmed-apply-STK-M0-23-2026-09-07`
- `persistence_mode`: `unchanged-active-only`
- `manifest_sha256`: `3363f0c3ea75a625...`; recalculado no servidor e **idêntico** ao registrado no journal
- `script_sha256`: `63b0ce735a73e352...` — o guard aprovado da `main`, idêntico ao arquivo do run
- `boot_id`: inalterado entre prepare, apply e confirmação
- ordem monotônica observada: `prepared < applied < confirmed`, com a confirmação
  cerca de um minuto após o apply — dentro da janela de 600 segundos
- atestações: `preflight.accepted.json` e `post.accepted.json` com **todos** os
  checks em `pass`, `source=operator-observed` e operador registrado como sessão
  serial com orquestração do Codex

## 3. Escopo normalizado do delta aplicado

| Objeto                 | Estado final                                                       |
| ---------------------- | ------------------------------------------------------------------ |
| IPv6 `INPUT`           | política `DROP`, com um único salto para a chain própria           |
| Chain própria de INPUT | loopback; `RELATED,ESTABLISHED`; ICMPv6; TCP/22 novo; `DROP` final |
| IPv6 `FORWARD`         | política `DROP`, com os saltos Docker preservados                  |
| IPv6 `OUTPUT`          | `ACCEPT`, sem alteração                                            |
| Políticas IPv4         | inalteradas                                                        |
| Tabela `nat` IPv4      | presente, sem alteração                                            |
| Saltos Docker          | preservados em IPv4 e IPv6                                         |
| Fail2Ban               | ativo, sem alteração                                               |
| rpcbind e SSH          | ativos, campos de autenticação do `sshd` inalterados               |
| Persistência           | inalterada; **nenhuma** ocorrência do delta no arquivo persistente |

A chain termina em `DROP` para o tráfego não permitido e não há regra
inalcançável. Nenhuma nova permissão web ou RPC foi aberta.

**Persistência permanece deliberadamente fora da janela:** o delta é ativo e
não durável; um reboot o remove. Isso é o comportamento aprovado, não uma
pendência de execução.

## 4. Estado terminal de timer, service e jobs

- timer de rollback: `inactive`, `static`, **sem próximo disparo** (`NextElapseUSecRealtime` vazio)
- service de rollback: `inactive`/`dead`, `Result=success`, `ExecMainStatus=0`
- nenhum job em `systemctl list-jobs`
- nenhuma unidade `stk6*` carregada (as duas unit files permanecem em disco, sem execução)
- apontador `active.json` aponta o run confirmado — não há recuperação pendente

## 5. Produção, backup e preservação

- cinco containers de produção `running/healthy`, sem OOM e sem reinício
- backup externo `state=ready`, com desvio de minutos em relação ao RPO
- disco bem acima dos gates (uso na casa de duas dezenas por cento)
- `SSH` + `sudo -n id -u` = `0` operantes; host key conhecida preservada
- stagings, bundles, journals, unit files e archives **preservados**: nada foi
  removido nesta tarefa

## 6. Preflight de 10/09/2026 — aborto seguro

A autorização para uma nova janela partiu da premissa de que a aplicação ainda
seria futura. O preflight de leitura encontrou o **oposto** e interrompeu antes
de prepare e apply, conforme os próprios gates do escopo:

| Exigido pela autorização                             | Estado real encontrado                                   |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `active.json` ausente                                | presente                                                 |
| units antigas ausentes                               | duas unit files `stk6-rollback-*` presentes              |
| IPv6 `INPUT/FORWARD` em `ACCEPT` e `INPUT` vazio     | `INPUT` e `FORWARD` já em `DROP`, com salto para a chain |
| ausência de chain `STK6` ou run ativo                | chain própria ativa                                      |
| nenhum staging `stk-ipv6-staging-m0-23` preexistente | staging presente                                         |

Executar prepare e apply nesse estado seria um **segundo apply**, expressamente
proibido pela autorização. As demais fases (console, credencial temporária,
prepare, apply, confirm, limpeza e rollback do checkout) **não** foram
executadas, e nenhum recurso foi criado, alterado ou removido. Nenhuma
limpeza pode ser declarada integral.

O preflight também confirmou os gates que independem da janela: `origin/main`
exata na base desta tarefa, os cinco checks aprovados nesse SHA, worktree
limpo, guard idêntico à `main`, Python 3.12.3, backend `ip6tables-nft`,
persistência igual ao estado documentado, mesmo guest e mesmo boot, nenhum job
residual e o archive administrativo do run legado preservado.

## 7. Limitações da evidência

- A evidência bruta da janela (snapshot, transcrição serial e tuplas de conexão)
  é **privada** e não entra no repositório; este registro é sanitizado.
- O delta **não** é persistente; não há comprovação de sobrevivência a reboot e
  nenhum reboot foi executado para testá-lo.
- Não existe IPv6 público no ambiente; a janela fecha a exposição implícita e
  **não** comprova conectividade IPv6 externa.
- DNS, OCI/IAM, SSH e portas 80/443 permaneceram fora do escopo e sem alteração.
- O descarte da chave temporária da integração serial **continua não comprovado**
  (pendência herdada da STK-M0-05); não é resolvido por esta reconciliação.
- A tabela de reconciliação de checkboxes em
  [M0-CHECKLIST.md](M0-CHECKLIST.md) é um retrato datado de 08/09/2026 e
  antecede esta tarefa; ela não foi recalculada.
- A execução e a documentação originais foram feitas pelo Codex sob autorização
  do proprietário; a verificação do próprio trabalho não é apresentada como
  revisão independente do GitHub.

## 8. Pendências que esta tarefa não encerra

- Rollback do checkout da STK-M0-29 **retido**; exclusão exige autorização
  específica, vinculada ao estado real.
- Stagings `stk-ipv6-staging-m0-06` e `stk-ipv6-staging-m0-23` preservados.
- Descarte da chave temporária serial não comprovado.
- Persistência do delta IPv6 fora do escopo, como tarefa própria.
- Nenhuma mutação na VPS foi executada por esta tarefa.
