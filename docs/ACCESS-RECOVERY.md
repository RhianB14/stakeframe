# Recuperação de acesso — preparação da validação

Tarefas: **STK-M0-04** (preparação, revisão R1 incorporada) e **STK-M0-05**
(registro da validação, issue #9). Status: **validação executada em 05/09/2026** —
registro completo no §9. Este documento não autoriza novas execuções: conexão de
console, credenciais e mutações no guest dependem de autorização específica e
separada.

- Evidência OCI (inspeção do Codex retransmitida): [NETWORK-SECURITY.md](NETWORK-SECURITY.md)
  §3 e §6. O painel não será repetido; consultas adicionais ficam sinalizadas
  para o Codex (§7 abaixo).
- Restauração de banco/aplicação é escopo distinto: [RECOVERY.md](RECOVERY.md).
- Fronteira conceitual: **ver a saída serial não é recuperação**; recuperação é
  a capacidade autenticada de operar o guest como administrador. Recuperação de
  acesso também não restaura banco, aplicação ou dados.

## 1. Estado observado (leitura focada, 05/09/2026)

Leitura somente leitura via SSH existente, com a identidade do host verificada
pelo `known_hosts` anterior (chave nova não aceita). Comandos foram entregues
por stdin, sem criação de arquivos no guest, e nenhum estado foi alterado.
Endereços, tuplas de conexão e qualquer material de identificação permanecem
privados; publicam-se conclusões sanitizadas.

### Transporte serial no guest

- Linha de comando do kernel inclui `console=tty1 console=ttyAMA0`: o console
  serial da instância é o **ttyAMA0** (ARM64), não `ttyS0`.
- `serial-getty@ttyAMA0.service` **ativo**, com
  `agetty -o '-p -- \u' --keep-baud 115200,57600,38400,9600`. A instância é
  gerada pela presença do console (systemd-getty-generator); o estado
  `disabled` refere-se ao template, não à instância ativa. `getty.target`
  ativo; `getty@tty1` também ativo.
- Conclusão: a configuração do guest está pronta para exibir prompt de login
  serial. **Getty ativo comprova configuração do guest; o transporte e o
  prompt interativo seguem dependendo do teste OCI (fases B–C).**

### Condições de autenticação pelo console

- Classificação de forma do shadow (sem leitura de hashes): **root `*`** e
  **ubuntu `!`** — **nenhuma das duas contas possui hash de senha**.
  `passwd -S` confirma `L` para ambas; `chage -l ubuntu` mostra última
  mudança em 30/08/2026 (data de provisionamento).
- Consequência: **não existe senha anterior a desbloquear**. O estado `L` não
  implica credencial anterior conhecida. O teste exigirá **definir** uma senha
  temporária nova (§4), não desbloquear uma existente.
- PAM do console: `common-auth` com `pam_unix` (`nullok`), sem backend
  alternativo de senha. Conta sem hash/bloqueada ⇒ senha não autentica.
- Conclusões de autenticação valem **somente para as contas e caminhos
  examinados** (root e usuário padrão da imagem; console serial e SSH).

### Acesso administrativo existente

- SSH como usuário padrão da imagem, `sudo` sem senha verificado
  (`sudo -n id -u` retornou 0) e grupo `sudo` presente. O caminho
  administrativo atual é SSH + sudo e está operante.

### sshd efetivo: configuração carregada e contexto da conexão real

- Processo em execução: `/usr/sbin/sshd -D` com `SSHD_OPTS` vazio
  (`/etc/default/ssh`); o unit executa `sshd -t` antes de iniciar. Nenhuma
  opção `-f`/`-o` alternativa.
- Configuração efetivamente carregada: `sshd_config` contém
  `Include /etc/ssh/sshd_config.d/*.conf` (única diretiva de inclusão) e
  **nenhuma linha `Match`**; `sshd_config.d/` contém um único arquivo
  (`60-cloudimg-settings.conf`), apenas com `PasswordAuthentication no`.
  A ausência de `Match` foi verificada **nos arquivos carregados**, não
  inferida de igualdade de saídas.
- Campos efetivos de autenticação (`sshd -T`, requer root): `UsePAM yes`,
  `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
  `AuthenticationMethods any`, `PubkeyAuthentication yes`,
  `PermitRootLogin without-password`, `UseDNS no`, porta 22.
- Contexto testado com a **tupla real observada pelo servidor**
  (`SSH_CONNECTION`: endereço do cliente, porta efêmera, endereço local e
  porta 22 — valores em evidência privada; coincide com o `FROM` exibido pelo
  servidor na sessão ativa): os campos de autenticação acima são **idênticos**
  ao contexto padrão. Uma consulta externa de IP não substitui essa evidência
  e não foi usada.
- Conclusão registrada: nessas condições, **uma senha definida no guest não
  autentica via SSH** — `PasswordAuthentication no` com
  `KbdInteractiveAuthentication no` e `AuthenticationMethods any` restringe
  o SSH a chave pública. SSH não foi alterado.

## 2. Pré-requisitos ainda não comprovados

> Estado registrado na preparação. Na STK-M0-05, os itens 1–3 foram validados
> dentro da janela autorizada (§9); o item 4 permanece inexplorado.

1. **IAM OCI** para leitura da instância e gerenciamento de
   `instance-console-connection` no compartment correto. Presença de botão no
   painel não prova autorização.
2. **Criação da conexão de console** (mutação OCI): via Cloud Shell (cria
   conexão e chave temporária) ou caminho local (par RSA conforme a
   documentação e alcance do endpoint de console por SSH em TCP/443). Não
   criada nesta tarefa.
3. **Credencial de login no guest**: não existe (nenhuma conta pertinente tem
   hash — §1). O teste exigirá **definir** senha temporária nova, mutação
   autorizada (§4).
4. **Caminho alternativo sem senha** (interação com o bootloader via serial,
   cloud-init/user-data): não investigado e não preparado. Qualquer exploração
   é tarefa separada com autorização própria.

## 3. Sequência proposta para o teste futuro

> Plano registrado na preparação; a execução efetiva (fases A–F) está em §9.

Cada fase só inicia com a anterior confirmada e com autorização vigente.
Evidência bruta é privada; publicam-se conclusões sanitizadas. A limpeza é
planejada **desde a criação** da conexão OCI, incluindo caminhos de falha
(§5).

- **A. Painel (Codex, leitura):** confirmar permissões efetivas de IAM e o
  caminho de conexão escolhido (Cloud Shell ou local). Nenhuma edição de
  políticas.
- **B. Conexão de console (mutação OCI autorizada):** criar a conexão, validar
  o endpoint e guardar o material de chave em segredo privado. Não tocar em
  mais nada da instância. Falha de transporte/endpoint ⇒ exclusão imediata da
  conexão e registro do que foi criado.
- **C. Transporte serial:** conectar e observar banner/prompt do getty.
  Sucesso = prompt visível e interativo. Apenas saída visível **não** é
  recuperação.
- **D. Credencial no guest (mutação autorizada):** com a conexão ativa,
  **definir senha temporária nova** para a conta padrão via `sudo`
  (§4) e autenticar no serial. Janela curta; sem terceiros com acesso ao
  computador durante o teste.
- **E. Capacidade administrativa:** na sessão serial autenticada, demonstrar
  `sudo -n id -u` = 0 e comandos de leitura (ex.: `journalctl -n`,
  `iptables -S`), provando capacidade sem alterar nada.
- **F. Encerramento e limpeza:** sair da sessão, **bloquear a senha**
  (§4 — efeitos exatos), verificar a forma resultante do shadow, encerrar e
  excluir a conexão de console, descartar a chave temporária, registrar
  recursos criados/removidos, arquivar evidência privada e publicar resumo
  sanitizado. **Falha de limpeza permanece pendência explícita — nunca
  declarar sucesso.**

## 4. Recursos temporários e mutações previstas

| Recurso/mutação                            | Impacto                                                                                                                              | Limpeza proposta                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conexão de console OCI (fase B)            | Recurso novo na instância; chave temporária                                                                                          | Excluir a conexão; descartar a chave                                                                                                                                                                                                                               |
| **Definição** de senha temporária (fase D) | Conta padrão passa a ter hash de senha (hoje não tem); login por senha possível no console; SSH permanece somente chave pública (§1) | `passwd -l` bloqueia a senha vigente, mas **deixa hash onde não havia** — `L` não comprova restauração integral. Restauração exata do campo pré-teste (`!`) via `usermod -p '!'` exige sudo e autorização; verificar por classificação de forma, sem publicar hash |

- **Operação proposta:** `sudo passwd <conta padrão>` na sessão de
  administração (prompt interativo do `passwd`), **nunca** senha em argumentos,
  variáveis de comando, histórico, logs, transcrições, documentos ou
  mensagens. Alternativa por stdin (`chpasswd`) só se o prompt interativo
  estiver indisponível, com o mesmo sigilo.
- **Responsável:** o proprietário define/guarda o segredo; a execução no guest
  ocorre sob autorização específica, pelo executor da janela. O segredo é
  gerado no momento do uso e tratado como material privado; não é gerado nem
  definido nesta preparação.
- **Estado pré-teste observado:** ubuntu `!`, root `*` (classificação de
  forma). **Não se presume credencial anterior conhecida.**
- Nenhuma edição de IAM, SSH, getty, boot, firewall ou persistência está
  contemplada. Nenhum reboot é previsto; se uma fase vier a exigir reboot, a
  janela é replanejada antes de prosseguir.

## 5. Interrupção, limpeza e registro de recursos

- **Registro:** antes de encerrar, listar os recursos efetivamente criados ou
  modificados (conexão de console, campo de senha, qualquer outro) e o
  resultado de cada limpeza. Recursos preexistentes são preservados; nenhuma
  restauração além do escopo autorizado.
- **Caminhos de falha cobertos desde a fase B:** falha de transporte/endpoint
  (excluir conexão imediatamente), falha de login no serial, falha de `sudo`
  na fase E, perda de sessão ou interrupção no meio do teste. Com o caminho
  SSH+sudo independente operante, a limpeza (bloqueio de senha e exclusão da
  conexão) pode ser concluída fora da sessão serial; se o SSH também estiver
  indisponível, a pendência de limpeza é registrada **explicitamente como
  pendência**, sem declarar sucesso.
- **Separação obrigatória entre resultados:**
  - **Teste pontual concluído** = fases A–F executadas e os recursos
    temporários removidos/registrados.
  - **Recuperação disponível durante uma futura janela** = condição distinta:
    após bloquear a senha e excluir a conexão, **não marcar automaticamente a
    recuperação como pronta**. O gate da janela futura exige acesso
    independente (console) **estabelecido e mantido durante a janela**, sem
    depender de SSH para recriá-lo após um bloqueio.

## 6. Critérios de sucesso, interrupção e evidências

- **Sucesso:** prompt serial visível; sessão autenticada no guest via serial;
  `sudo -n id -u` = 0 nessa sessão; limpeza confirmada (shadow na forma
  combinada e conexão de console excluída) **e** registro de recursos
  criados/removidos concluído.
- **Interrupção:** falha de conexão ou de endpoint antes da fase D encerra sem
  mutação de credencial; três falhas de login ou falha de `sudo` encerram a
  janela e mantêm a limpeza; perda de sessão aciona o caminho de limpeza via
  SSH (§5); qualquer resultado indesejado no guest prioriza restaurar o estado
  anterior pelos meios já disponíveis.
- **Evidências privadas:** transcrição serial com marcações de tempo, saídas
  dos comandos de verificação, classificação de forma do shadow antes/depois
  (sem hashes), tupla de conexão e confirmação da exclusão da conexão.
  **Públicas:** resumo sanitizado neste documento e no checklist do M0, sem
  endereços, segredos ou hashes.

## 7. Consultas adicionais ao Codex (quando necessárias)

Leituras de painel para o Codex executar sob demanda, sem repetir a inspeção
anterior e sem acionar botões: (a) permissões efetivas do usuário/grupo para
`manage instance-console-connection` no compartment da instância; (b) região e
endpoint de console da instância; (c) habilitação de Cloud Shell na tenancy.

## 8. Registro da preparação (STK-M0-04, 05/09/2026; revisão R1 no mesmo dia)

- Leitura focada somente leitura executada via SSH existente; identidade do
  host verificada; nenhum arquivo criado no guest; nenhum estado alterado.
- Revisão R1: conclusão sobre `Match` fundamentada na configuração carregada
  (não em igualdade de saídas); tupla real observada pelo servidor; campos de
  autenticação SSH registrados antes de qualquer afirmação sobre senha futura;
  credencial do teste reclassificada de desbloqueio para definição; limpeza e
  interrupção completadas desde a criação da conexão; separação explícita
  entre teste concluído e recuperação pronta para janela.
- Este documento criado; NETWORK-SECURITY §6 e M0-CHECKLIST atualizados por
  referência.
- Não foram criados conexão, chave, senha, conta ou recurso OCI; não houve
  reinício, instalação de pacotes, transferência de scripts operacionais,
  armamento de timers nem execução de aplicação/rollback.

## 9. Registro da validação (STK-M0-05, 05/09/2026)

Execução autorizada dentro da janela, seguindo a sequência A–F de §3 com os
papéis separados por evidência. Base: `main` `98a5b95606098066258c1fcf0fd63fa1c32348a5`.
Nenhuma operação além do escopo autorizado; sem firewall, reboot, IAM, SSH,
boot ou persistência.

### Execução e responsabilidade

- **IAM e transporte (Codex):** IAM validado; conexão de console criada via
  Cloud Shell; prompt de login visível no console serial. A conexão do teste
  de transporte anterior havia sido excluída automaticamente ao sair.
- **Credencial (proprietário):** senha temporária definida por digitação
  própria em `sudo passwd <conta padrão>`, no terminal administrativo
  entregue para esse fim — o segredo não transitou por chat, argumentos,
  histórico, logs, transcrições nem documentos; nenhum assistente registrou
  ou exibiu o valor.
- **Autenticação serial (Codex, provas):** sessão autenticada com
  `tty` = `/dev/ttyAMA0`, `id -un` = conta padrão e `sudo -n id -u` = `0` —
  autenticação e capacidade administrativa comprovadas dentro da janela.
- **Encerramento (Codex):** logout serial e exclusão da conexão confirmados —
  estado `DELETED` às 23:32:58 UTC, tabela de conexões vazia e Cloud Shell
  encerrado.

### Restauração (Hermes, verificada às 23:26:28 UTC)

- Campo de senha da conta padrão restaurado à forma pré-teste (**sem hash** —
  `!`), removendo integralmente o hash temporário; `passwd -l` sozinho não
  seria suficiente. Verificação por classificação de forma, sem publicar
  hashes.
- Metadados de envelhecimento restaurados e conferidos: `lastchg` de volta ao
  valor de provisionamento (20695) e min/max/warn/inactive/expire idênticos à
  linha de base.
- **root inalterado** (`*`, forma pré-teste); SSH + sudo permaneceram
  operantes (`sudo -n id -u` = 0; campos de autenticação do sshd sem
  mudança); `serial-getty@ttyAMA0` ativo ao final.
- Mutações executadas: `usermod -p` (restauração do campo) e `chage -d`
  (metadado), ambas com rc=0 e verificação pré→pós integrada.

### Limitações e pendências (não declarar limpeza integral)

- **Descarte da chave temporária da integração não comprovado.** Não afirmar
  limpeza integral e não supor que um arquivo existiu; a inspeção do Cloud
  Shell comum não estabelece equivalência com o ambiente da integração serial.
- Teste pontual concluído **não** marca a recuperação como pronta para janela
  futura: qualquer janela de firewall exige console independente estabelecido
  e mantido durante a janela, sem depender de SSH para recriá-lo após bloqueio
  (§5).
- Registros históricos da preparação (§1–§8) preservados sem reescrita.
