# STK-M0-06 — reconciliação controlada

A reconciliação é uma operação separada de `apply`, `confirm` e `rollback`.
Esta implementação é local e não foi executada contra a VPS.

## Comandos

```text
python -m scripts.network_security.reconciliation status --state-dir <dir> --run-id f15efb347860c80f9271
python -m scripts.network_security.reconciliation reconcile --state-dir /var/lib/stk-ipv6 --run-id f15efb347860c80f9271 --execute-reviewed-linux

python -m unittest scripts.network_security.test_reconciliation -q
python -m unittest scripts.network_security.integration_reconciliation -q
```

`status` somente lê. `reconcile` exige Linux/root, o sinal explícito
`--execute-reviewed-linux` e o diretório fixo `/var/lib/stk-ipv6`. Em ambos, o
mesmo `operation.lock` global é adquirido com timeout.

## Pré-condições e verificações

Antes de remover qualquer arquivo, o procedimento valida:

- run existente em `rollback_incomplete`, identidade do journal/manifest,
  `active.json` apontando exatamente para o run e boot id inalterado;
- snapshot IPv6 atual igual ao `before`, hashes da persistência iguais ao bundle,
  e evidência independente do IPv4 ativo ligada ao run e ao seu SHA-256. Hash de
  `rules.v4` não substitui a comprovação do estado IPv4 ativo;
- hashes do script de rollback e do backup original exatamente conforme o
  manifest antigo. O reconciliador novo não precisa ter o hash do script antigo;
- leitura própria de quiescência systemd: service e timer `inactive/dead`, timer
  sem próximo disparo, resultado/status limpos, timestamp de execução conhecido,
  nenhuma evidência positiva anterior e nenhum job. Uma referência adquirida
  agora não é tratada como prova de histórico anterior; estado desconhecido não
  vira zero;
- para cada service/timer, `FragmentPath`, conteúdo e SHA-256 coincidem com o
  unit file do bundle antigo.

Qualquer observação ausente, desconhecida, divergente, execução, job, colisão,
path inesperado ou alteração de bytes interrompe a operação.

## Procedimento e retomada

1. Cria evidência privada `reconciliation-<run>.json` com identidade, boot,
   hashes vinculados ao manifest/journal, readbacks e estado por arquivo.
2. Grava `remove-intent` durável antes de cada remoção.
3. Remove somente os dois unit files comprovadamente próprios. O estado físico
   após `unlink` pode ainda estar carregado no systemd; isso não é confundido
   com `not-found` imediato.
4. Executa `daemon-reload` e só então verifica ausência física, `LoadState=not-found`,
   estado inativo e ausência de jobs.
5. Mantém `active.json` intacto até a limpeza estar comprovada.
6. Grava intenção de archive, cria o destino exclusivamente, confirma seus bytes
   e registra `archive-created` antes de remover `active.json`.
7. Remove `active.json`, confirma sua ausência e só então registra `archived` e
   `complete`.

Falhas são recuperáveis nos pontos após `unlink`, após `daemon-reload`, após a
criação do archive e após a remoção de `active.json`. Um retry revalida boot,
identidade, manifest/journal, hashes do bundle original, evidência, restauração,
persistência, IPv4 e readbacks antes de continuar. Intenções duráveis e
proveniência são obrigatórias; ausência isolada ou bytes coincidentes sem
vínculo não provam conclusão.

Um archive completo só permite no-op se o reconciliador revalidar boot,
journal/manifest, script/backup/units do bundle, evidência, restauração,
persistência, IPv4, archive íntegro, ausência dos units/jobs e ausência de
`active.json`. Qualquer mudança posterior impede a declaração de sucesso.

## Diferença entre bundle antigo e reconciliador

O bundle antigo (`manifest.json`, `journal.json`, script, backup, hashes e unit
files) permanece a fonte de autoridade. `reconciliation.py` é um novo
procedimento de limpeza; não é instalado no bundle, não altera `script_sha256`,
não altera hashes antigos e não faz apply, rollback, release ou deploy.

## Validação

- `integration_reconciliation.py` é o fixture local correspondente; a execução
  unitária com o backend descartável bloqueia firewall real e cobre a
  permanência carregada após unlink até `daemon-reload`, conclusão, retomada e
  repetição. Um container systemd real deve executar o mesmo contrato com
  `STK_DISPOSABLE_SYSTEMD=1`.
- `test_reconciliation.py` usa backend em memória e cobre sucesso, repetição,
  concorrência no lock global, remoção parcial, unit mantido carregado após
  `unlink`, falha de `daemon-reload`, interrupções após `unlink`, após
  `daemon-reload`, após criar archive e após remover `active.json`, colisão de
  archive, identidade incorreta, script/backup/unit alterado, `FragmentPath`
  incorreto, boot diferente, snapshot/IPv4/persistência divergentes, estados
  systemd desconhecidos, execução/job pendente e `status` sem mutação.

A integração systemd real deve ser executada somente em container descartável
com PID 1 systemd, firewall/persistência fictícios, comandos reais de firewall
bloqueados e unidades mantidas carregadas após unlink. `integration_reconciliation.py`
é o fixture local correspondente; a execução do fixture requer opt-in explícito
`STK_DISPOSABLE_SYSTEMD=1`. Nesta máquina Windows, o fixture foi deliberadamente
ignorado; o container disponível não possui systemd instalado. Nenhuma execução
em VPS é válida como teste desta branch.
