# STK-M0-06 — reconciliação controlada

A reconciliação é uma operação separada de `apply`, `confirm` e `rollback`.
Esta implementação é local e não foi executada contra a VPS.

## Comandos

```text
python -m scripts.network_security.reconciliation status --state-dir <dir> --run-id f15efb347860c80f9271
python -m scripts.network_security.reconciliation reconcile --state-dir /var/lib/stk-ipv6 --run-id f15efb347860c80f9271 --execute-reviewed-linux
```

`status` somente lê. `reconcile` exige Linux/root, o sinal explícito
`--execute-reviewed-linux` e o diretório fixo `/var/lib/stk-ipv6`. Em ambos, o
mesmo `operation.lock` global é adquirido com timeout.

## Pré-condições e verificações

Antes de remover qualquer arquivo, o procedimento valida:

- run existente em `rollback_incomplete`, identidade do journal/manifest,
  `active.json` apontando exatamente para o run e boot id inalterado;
- snapshot IPv6 atual igual ao `before`, hashes da persistência iguais ao bundle,
  sem modificar firewall, persistência ou o journal original;
- timer `inactive/dead`, sem próximo disparo, service `inactive/dead` com
  `Result=success`, status zero, timestamp monotônico zero e nenhum job;
- para cada service/timer, `FragmentPath`, conteúdo e SHA-256 coincidem com o
  unit file do bundle antigo. O reconciliador novo não substitui hashes do run.

Qualquer observação ausente, desconhecida, divergente, execução, job, colisão,
path inesperado ou alteração de bytes interrompe a operação.

## Procedimento e retomada

1. Cria evidência privada `reconciliation-<run>.json` com identidade, boot,
   hashes, readbacks e estado por arquivo.
2. Grava `remove-intent` durável antes de cada remoção.
3. Remove somente os dois unit files comprovadamente próprios.
4. Executa `daemon-reload` e verifica ausência física, `LoadState=not-found` e
   ausência de jobs.
5. Mantém `active.json` intacto até a limpeza estar comprovada.
6. Grava intenção de archive, preserva seus bytes e arquiva para
   `active.reconciled-<run>.json`; colisão é recusada. Só depois grava `complete`.

Falha parcial preserva `active.json` e a evidência separada. Um retry revalida
boot, identidade, active, bundle, conteúdo e hashes antes de continuar. Um unit
com intenção válida e readback de ausência pode ser retomado; ausência isolada
nunca prova conclusão. Um archive completo só permite no-op se o archive, a
identidade, a ausência dos units/jobs e a ausência de `active.json` forem todos
comprovados.

## Diferença entre bundle antigo e reconciliador

O bundle antigo (`manifest.json`, `journal.json`, hashes e unit files) permanece
a fonte de autoridade. `reconciliation.py` é um novo procedimento de limpeza;
não é instalado no bundle, não altera `script_sha256`, não altera hashes antigos
e não faz apply, rollback, release ou deploy.

## Validação

`test_reconciliation.py` usa backend em memória e cobre sucesso, repetição,
concorrência no lock global, remoção parcial, falha de `daemon-reload`, colisão
de archive, identidade incorreta, unit/bundle alterado, `FragmentPath` incorreto,
boot diferente, snapshot/persistência divergentes, estados systemd desconhecidos,
execução/job pendente e `status` sem mutação.

A integração systemd real deve ser executada somente em container descartável
com PID 1 systemd e firewall/persistência fictícios, seguindo o padrão de
`integration_systemd.py`. Nenhuma execução em VPS é válida como teste desta
branch.
