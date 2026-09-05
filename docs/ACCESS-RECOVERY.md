# Recuperação de acesso — preparação da validação

Tarefa: **STK-M0-04**. Status: **preparação** — este documento organiza o teste
futuro de recuperação de acesso OCI/Ubuntu e não autoriza a sua execução.
Conexão de console, credenciais e mutações no guest dependem de autorização
específica e separada.

- Evidência OCI (inspeção do Codex retransmitida): [NETWORK-SECURITY.md](NETWORK-SECURITY.md)
  §3 e §6. O painel não será repetido; consultas adicionais ficam sinalizadas
  para o Codex (§6 abaixo).
- Restauração de banco/aplicação é escopo distinto: [RECOVERY.md](RECOVERY.md).
- Fronteira conceitual: **ver a saída serial não é recuperação**; recuperação é
  a capacidade autenticada de operar o guest como administrador. Recuperação de
  acesso também não restaura banco, aplicação ou dados.

## 1. Estado observado (leitura focada, 05/09/2026)

Leitura somente leitura via SSH existente, com a identidade do host verificada
pelo `known_hosts` anterior (chave nova não aceita). Comandos foram entregues
por stdin, sem criação de arquivos no guest, e nenhum estado foi alterado.
Identificadores de conexão e endereços permanecem privados.

### Transporte serial no guest

- Linha de comando do kernel inclui `console=tty1 console=ttyAMA0`: o console
  serial da instância é o **ttyAMA0** (ARM64), não `ttyS0`.
- `serial-getty@ttyAMA0.service` **ativo**, com
  `agetty -o '-p -- \u' --keep-baud 115200,57600,38400,9600`. A instância é
  gerada pela presença do console (systemd-getty-generator); o estado
  `disabled` refere-se ao template, não à instância ativa. `getty.target`
  ativo; `getty@tty1` também ativo.
- Conclusão: o guest está pronto para exibir prompt de login serial assim que
  existir conexão de console. Nada precisou ser configurado e nada foi
  alterado.

### Condições de autenticação pelo console

- `passwd -S` (não lê hashes): **root L** e **ubuntu L** — as duas contas
  pertinentes estão com senha **bloqueada**.
- PAM do console: `common-auth` com `pam_unix` (`nullok`), sem backend
  alternativo de senha. Conta bloqueada ⇒ senha não autentica.
- SSH é independente do console: `PasswordAuthentication no`.
- Conclusão: **hoje nenhuma credencial de senha abre o login serial**. O teste
  de autenticação exigirá desbloqueio temporário, mutação autorizada (§4).

### Disponibilidade do acesso administrativo existente

- SSH como usuário padrão da imagem, `sudo` sem senha verificado
  (`sudo -n id -u` retornou 0) e grupo `sudo` presente. O caminho
  administrativo atual é SSH + sudo e está operante.

### Contexto efetivo do sshd (limitação da R1 encerrada)

- Três contextos de `sshd -T`: sem `-C`, com `host=` na identidade real do
  cliente e com `host=192.0.2.1` de contraste. Os três resultados são
  **byte-idênticos** (95 linhas, comparação por hash). **Não há blocos
  `Match`** no sshd.
- A identidade usada foi o IP público do cliente, resolvido na mesma rede da
  conexão; com `usedns no`, o sshd compara endereços, portanto o contexto é
  fiel à conexão real.
- `PasswordAuthentication no` e `PermitRootLogin without-password` valem
  globalmente, sem exceções por host.

## 2. Pré-requisitos ainda não comprovados

1. **IAM OCI** para leitura da instância e gerenciamento de
   `instance-console-connection` no compartment correto. Presença de botão no
   painel não prova autorização.
2. **Criação da conexão de console** (mutação OCI): via Cloud Shell (cria
   conexão e chave temporária) ou caminho local (par RSA conforme a
   documentação e alcance do endpoint de console por SSH em TCP/443). Não
   criada nesta tarefa.
3. **Credencial de login no guest**: com as contas bloqueadas (§1), não há como
   autenticar no serial sem desbloqueio temporário autorizado.
4. **Caminho alternativo sem senha** (interação com o bootloader via serial,
   cloud-init/user-data): não investigado e não preparado. Qualquer exploração
   é tarefa separada com autorização própria.

## 3. Sequência proposta para o teste futuro

Cada fase só inicia com a anterior confirmada e com autorização vigente.
Evidência bruta é privada; publicam-se conclusões sanitizadas.

- **A. Painel (Codex, leitura):** confirmar permissões efetivas de IAM e o
  caminho de conexão escolhido (Cloud Shell ou local). Nenhuma edição de
  políticas.
- **B. Conexão de console (mutação OCI autorizada):** criar a conexão, validar
  o endpoint e guardar o material de chave em segredo privado. Não tocar em
  mais nada da instância.
- **C. Transporte serial:** conectar e observar banner/prompt do getty.
  Sucesso = prompt visível e interativo. Apenas saída visível **não** é
  recuperação.
- **D. Autenticação no guest (mutação no guest autorizada):** com a conexão
  ativa, desbloquear temporariamente a senha do usuário padrão, autenticar no
  serial e seguir imediatamente à fase E. Janela curta, sem terceiros com
  acesso ao computador durante o teste.
- **E. Capacidade administrativa:** na sessão serial autenticada, demonstrar
  `sudo -n id -u` = 0 e comandos de leitura (ex.: `journalctl -n`,
  `iptables -S`), provando capacidade sem alterar nada.
- **F. Encerramento e limpeza:** sair da sessão, re-bloquear a senha, confirmar
  `L` em `passwd -S`, encerrar e excluir a conexão de console, descartar a
  chave temporária, arquivar evidência privada e publicar resumo sanitizado.

## 4. Recursos temporários e mutações previstas

| Recurso/mutação                             | Impacto                                                                                    | Limpeza proposta                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Conexão de console OCI (fase B)             | Recurso novo na instância; chave temporária                                                | Excluir a conexão; descartar a chave                                  |
| Senha temporária no usuário padrão (fase D) | Login por senha passa a ser possível no console; SSH permanece `PasswordAuthentication no` | `passwd -l` imediatamente após a fase E; confirmar `L` em `passwd -S` |

Nenhuma edição de IAM, SSH, getty, boot, firewall ou persistência está
contemplada. Nenhum reboot é previsto; se uma fase vier a exigir reboot, a
janela é replanejada antes de prosseguir.

## 5. Critérios de sucesso, interrupção e evidências

- **Sucesso:** prompt serial visível; sessão autenticada no guest via serial;
  `sudo -n id -u` = 0 nessa sessão; limpeza confirmada (conta `L` novamente e
  conexão de console excluída).
- **Interrupção:** falha de conexão ou de endpoint antes da fase D encerra sem
  mutações; três falhas de login ou falha de `sudo` encerram a janela e mantêm
  a limpeza; qualquer resultado indesejado no guest prioriza restaurar o
  estado anterior com os meios já disponíveis (SSH).
- **Evidências privadas:** transcrição serial com marcações de tempo, saídas
  dos comandos de verificação, estados de `passwd -S` antes/depois e
  confirmação da exclusão da conexão. **Públicas:** resumo sanitizado neste
  documento e no checklist do M0.

## 6. Consultas adicionais ao Codex (quando necessárias)

Leituras de painel para o Codex executar sob demanda, sem repetir a inspeção
anterior e sem acionar botões: (a) permissões efetivas do usuário/grupo para
`manage instance-console-connection` no compartment da instância; (b) região e
endpoint de console da instância; (c) habilitação de Cloud Shell na tenancy.

## 7. Registro da preparação (STK-M0-04, 05/09/2026)

- Leitura focada somente leitura executada via SSH existente; identidade do
  host verificada; nenhum arquivo criado no guest; nenhum estado alterado.
- Este documento criado; NETWORK-SECURITY §6 e M0-CHECKLIST atualizados por
  referência.
- Não foram criados conexão, chave, senha, conta ou recurso OCI; não houve
  reinício, instalação de pacotes, transferência de scripts operacionais,
  armamento de timers nem execução de aplicação/rollback.
