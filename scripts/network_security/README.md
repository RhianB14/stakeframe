# Guard IPv6 — artefato operacional em revisão

> **STK-M0-03-R2: somente preparação local.** Não executar o caminho Linux,
> transferir arquivos, armar timers ou aplicar regras nesta rodada. Merge e
> aplicação dependem de autorização explícita do Codex, retransmitida pelo
> proprietário, e da validação separada da recuperação.

Runbook e proveniência das evidências:
[docs/NETWORK-SECURITY.md](../../docs/NETWORK-SECURITY.md).

## Implementação e limites

- `ipv6_guard.py`: uma implementação, com `Controller`, armazenamento privado,
  lock compartilhado e `LinuxAdapter` de comandos estritamente delimitados.
- `test_ipv6_guard.py`: substitutos de firewall/systemd em memória e runner
  injetado para validar a interface do adaptador. Não usa root, SSH ou comandos
  reais de firewall/systemd. A suíte bloqueia `subprocess.Popen` e `os.system`.
- Python 3.11+ e biblioteca padrão; nenhuma dependência de aplicação adicionada.
- Alvo futuro condicionado: Ubuntu 24.04 ARM64, `ip6tables 1.8.10 (nf_tables)`.
  Divergência ou comando indisponível bloqueiam o caminho real; não instalar
  pacotes automaticamente. Validar os executáveis absolutos do adaptador,
  incluindo Python, ip6tables, systemctl e busctl, no preflight autorizado.
- Escopo: estado **ativo** de IPv6 `INPUT/FORWARD`. IPv4, OUTPUT, NAT,
  Docker/Fail2Ban, SSH, rpcbind, OCI e persistência não são modificados.
- Pré-condição específica: INPUT IPv6 vazio, conforme a proposta guest da R1.
  Se o novo preflight mostrar regras nessa chain, abortar e revisar; não
  transplantar essas regras nem transformá-las silenciosamente em outra política.
- A chain da execução é preenchida antes da conexão ao INPUT e termina em DROP.
  A alteração de política FORWARD não apaga/reordena saltos Docker existentes.
  Ver a matriz aprovada; este arquivo não duplica as regras em shell.

## Comandos seguros agora: inspeção offline e simulação

Na raiz do repositório, no Windows:

```text
python -B scripts/network_security/ipv6_guard.py plan
python -B -m unittest discover -s scripts/network_security -p "test_*.py" -v
```

Em Linux/CI, usar `python3` em vez de `python`. `plan` devolve JSON com o
contrato, nomes exatos de checks e comandos; não instancia o adaptador Linux,
não grava arquivos, não faz probes e não acessa a rede. A suíte usa diretórios
temporários privados, removidos ao final.

Sintaxe pode ser validada com `ast.parse` sobre os arquivos Python, sem gerar
bytecode ou executar o adaptador. A CI executa a suíte separadamente da
formatação. **Simulação não valida kernel, systemd real ou conectividade da VPS.**

## Interface futura — não executar nesta tarefa

O sufixo `--execute-reviewed-linux` é apenas uma trava contra invocação
acidental; **não concede autorização**. O caminho real também exige Linux,
root e diretório fixo `/var/lib/stk-ipv6`, com ancestrais confiáveis e permissões
privadas. Não usar diretórios alternativos para contornar o lock global.

Comandos da mesma implementação:

- `prepare --execute-reviewed-linux [--window-seconds SEGUNDOS]`: faz leitura do
  backend, recusa colisões e prepara o bundle privado. Gera um run ID aleatório
  quando `--run-id` é omitido. Não conecta a chain nem instala/arma as unidades.
- `apply --execute-reviewed-linux --run-id ID --attestation ARQUIVO
--attestation-sha256 HASH`: valida artefatos/evidências, adquire unidades
  próprias, arma e valida o timer, preenche a chain, conecta e altera políticas.
- `confirm --execute-reviewed-linux --run-id ID --attestation ARQUIVO
--attestation-sha256 HASH`: exige evidência pós-alteração e nova conexão SSH;
  coordena parada do timer e estado da service sob o lock.
- `rollback --execute-reviewed-linux --run-id ID --trigger manual`: recupera
  somente o delta próprio. A service usa a mesma entrada com `--trigger timer`.
- `status --run-id ID`: lê o estado privado; não faz readback do kernel/systemd.
  Seu resumo não substitui os probes nem autoriza declarar sucesso.

Invocar com o mesmo script revisado (`python3 -I -B CAMINHO_DO_SCRIPT COMANDO`).
O adaptador não instala o interpretador nem transfere seus próprios arquivos.
Preparação, transporte e criação da cópia externa dependem da futura janela
separadamente autorizada. A janela padrão é 600 segundos; o intervalo aceito é
120 a 1800 segundos. Se o tempo for insuficiente, abortar/revisar, não estender
um timer já ativo sem novo protocolo.

### Bundle privado e propriedade

Sob `/var/lib/stk-ipv6/<run-id>/`, `prepare` gera:

- `ipv6_guard.py`: cópia exata da implementação para recuperação autônoma;
- `manifest.json`: identidade, boot, políticas/ruleset IPv6 anteriores, hashes
  do script/unidades/backup, modo de persistência e instante monotônico;
- `journal.json`: intenções, resultados e falhas de aplicação/recuperação;
- `persistence.before.json`: backup de bytes, com ausência representada por
  `null`; não é um comando de restauração de ruleset;
- `stk6-rollback-<run-id>.service` e `.timer`, gerados pela implementação.

O lock é `/var/lib/stk-ipv6/operation.lock`, comum a **todas** as execuções;
`active.json` impede rollback de uma execução antiga contra uma mais nova.
Arquivos privados usam modo 0600 e diretórios 0700. O bundle contém dados
sensíveis: não publicar nem colocá-lo no repositório.

Antes de aplicar, conservar esse bundle completo **no servidor** e uma cópia
privada externa verificada por hash, além da evidência privada completa de
IPv4/IPv6, NAT, rede, Docker/Fail2Ban e persistência requerida pelo runbook.
A cópia externa precisa existir antes da mudança; o script não a cria nem
comprova seu transporte automaticamente.

O run ID tem formato restrito; nomes de chain derivam dele e ficam abaixo do
limite do backend. Não adotar diretórios, chains ou unidades preexistentes,
mesmo com conteúdo idêntico. As unidades operacionais pertencem à execução e
são instaladas apenas na futura aplicação, em `/run/systemd/system`, sem enable.

### Evidência/atestação: integridade, não prova automática

`apply` e `confirm` exigem JSON privado com SHA-256 fornecido explicitamente.
O script valida identidade, boot, tempo monotônico, checks exatos e hashes dos
arquivos associados. **Ele não abre SSH, não executa probes de rede, não lê o
painel OCI e não autentica por assinatura a declaração do operador.**

Formato estrutural abaixo, deliberadamente **incompleto e não executável**:

```json
{
  "schema": 1,
  "kind": "preflight",
  "source": "operator-observed",
  "run_id": "<ID_DA_EXECUCAO>",
  "manifest_sha256": "<HASH_DO_MANIFESTO_PRIVADO>",
  "boot_id": "<BOOT_DO_GUEST>",
  "persistence_mode": "unchanged-active-only",
  "operator": "<RESPONSAVEL_PRIVADO>",
  "authorization_ref": "<AUTORIZACAO_EXPLICITA_DO_CODEX>",
  "original_session": "<IDENTIFICADOR_DA_CONEXAO_ORIGINAL>",
  "second_session": "<IDENTIFICADOR_DE_OUTRA_CONEXAO_REAL>",
  "observed_monotonic_ns": null,
  "expires_monotonic_ns": null,
  "checks": {}
}
```

- `kind` é `preflight` para apply, `post` para confirm. Nomes exatos dos checks
  vêm de `plan`/`PREFLIGHT_CHECKS`/`POST_CHECKS`, evitando uma lista duplicada
  sujeita a drift. Não preencher pass automaticamente para contornar um gate.
- Cada check exige `file` (basename de arquivo adjacente ao JSON), `sha256`
  e `outcome: "pass"`. O arquivo deve conter a evidência real, não vazia.
  Probes reprovados, ausentes ou inconclusivos impedem confirmação.
- O preflight `oci_codex_relay_reviewed` referencia a inspeção do Codex já
  retransmitida; **não solicita repetir o painel**. Os checks pós-alteração
  não incluem nova inspeção OCI. `provider_recovery` é a validação separada
  ainda pendente, não a simples presença de botões no painel.
- Obter boot e instantes no **mesmo guest**, no momento das observações, usando
  leitura do boot ID e `time.monotonic_ns()` do Python. Não usar relógio do
  computador do operador, epoch/realtime, números do teste ou valores inventados.
- `observed_monotonic_ns` deve ser inteiro posterior ao prepare/apply pertinente;
  `expires_monotonic_ns` deve ser inteiro futuro no momento da validação.
  Checks humanos demorados devem levar ao aborto e nova preparação, não a
  retrodatação de evidências.
- Para `post`, adicionar `second_session_opened_monotonic_ns`, obtido quando
  uma **nova conexão SSH independente** for aberta depois do apply. Deve ser
  posterior ao instante de aplicação e anterior/igual à observação. Multiplexar
  a conexão antiga ou apenas reutilizar uma segunda conexão anterior não atende.
- Guardar outputs completos e identificadores de sessão em local privado;
  anexar ao GitHub somente conclusões sanitizadas. SHA-256 atesta integridade
  dos bytes, não a veracidade de um teste que não foi executado.

### Timer, confirmação e falhas

As unidades são renderizadas por `render_units`, não mantidas como outra
implementação em Markdown. `OnActiveSec` é monotônico, com `WakeSystem=false`,
sem agendamento realtime, jitter aleatório ou persistência. A service executa
um oneshot da cópia local do script, sem restart automático; o timer não é
habilitado para boot.

O adaptador consulta estados/resultado/status/start timestamp e jobs pendentes;
usa D-Bus para ler microsegundos monotônicos sem interpretar durações humanas.
Recusa de `GetUnit` por unidade não carregada é um estado definido, não falha
transitória: unidades quiescentes são descarregadas pelo gerenciador e o `show`
anterior só as recarrega como cliente efêmero. A recusa é classificada por
identidade e resolvida por readback quiescente imediato (inativa/dead, sem job
e sem valor não nulo exposto no show); falha D-Bus desconhecida segue recusa
dura e nenhum estado é convertido em sucesso.
A aplicação repete essa validação após a última mutação e gravação do estado
aplicado. Se o rollback iniciou ou foi enfileirado, libera o lock para o worker,
aguarda sua conclusão e retorna falha de aplicação. A espera relê o delta ativo
recuperado e o bundle sob o lock; não aceita somente o journal de sucesso.
A confirmação para somente o timer, sob coordenação do lock. Um recibo privado
registra a entrada do rollback antes de ele aguardar o lock. Se a service já
iniciou, liberar o lock conforme o protocolo, aguardar e revalidar: **isso não
é aplicação confirmada**, mesmo se o rollback terminar com sucesso.

Na futura janela, inspecionar privadamente `journal.json`, o recibo
`rollback-started.json` e os registros systemd da `.service/.timer` pertinentes.
`ActiveState`, `SubState`, `Result`, `ExecMainStatus`, timestamp de início e jobs
são campos do systemd; `journal.json` é registro do script, não uma exportação
do journald. Um estado failed ou ativação sem recibo exige examinar os registros
privados da unidade. Não publicar esses logs, limpar failed ou reiniciar/matar
a service para produzir aparência de sucesso.

A recuperação restaura e confirma políticas anteriores antes de retirar regras
que preservam acesso; remove somente recursos cuja propriedade foi estabelecida.
Depois do detach, remove regras tagged exatas com `-D` em ordem inversa; não
oferece `flush`, nem na chain própria. Regras/referências externas concorrentes
fazem `-X` falhar sem apagá-las. Falha parcial mantém um prefixo próprio válido
para retry; conteúdo externo exige inspeção manual, nunca adoção por nome.
Erro de registro não deve impedir outras ações seguras. Um timer ainda pendente
não deve ser cancelado enquanto restarem restrições próprias após rollback
incompleto. Conservar um timer já disparado não implica novo retry; falhas
exigem recuperação manual supervisionada ou via OCI, sem inventar sucesso.

O comando retorna resumo sanitizado e código não zero em recusa/falha. Não
tratar fase `rollback_incomplete`, falta de journal/manifest, boot diferente,
lock ocupado ou service em andamento como autorização para limpar recursos
manualmente por nome/prefixo ou restaurar rulesets completos. Consultar o runbook,
inspecionar evidências e repetir a mesma entrada de rollback quando for seguro;
nunca usar `systemctl stop` na service de rollback em execução.

### Persistência e reboot

Modo único: `unchanged-active-only`. Não há save/reload nem escrita de regras
persistentes. Ausência e hashes de arquivos são registrados; falha de leitura,
backup corrompido ou drift bloqueiam aplicação/confirmação. A recuperação ainda
tenta restaurar o estado ativo e comunica erro de persistência, sem sobrescrever
mudanças externas que não pertencem à execução.

O reboot encerra este hardening ativo conforme o estado persistente preexistente;
a rotina recusa atuar com evidência de outro boot. Persistência futura precisa
de delta/backup/restauração próprios revisados e testes que comprovem que o boot
não reintroduz uma mudança revertida. Isso não faz parte desta janela.
