# Encerramento administrativo do run legado

STK-M0-22 prepara uma decisão operacional para o run
`f15efb347860c80f9271`. A referência IPv4 anterior ao `prepare` não foi
localizada. O [reconciliador histórico](RECONCILIATION.md) continua exigindo
essa referência; este comando separado não a fabrica nem altera aquela regra.

**Estado: execução autorizada e concluída em 07/09/2026**, com verificação
posterior e cópias privadas externas. Resultado em
[M0-22-VALIDATION.md](../../docs/M0-22-VALIDATION.md). A proposta e os comandos
abaixo documentam o procedimento executado; não autorizam outra operação.

## O que pode ser autorizado

Aceitar explicitamente o SHA-256 de uma leitura atual de
`iptables -w 5 -t filter -S`, encerrar administrativamente o registro antigo e
preservar a lacuna histórica. Isso permite remover somente as duas units
adquiridas por esse run e arquivar os bytes de `active.json`. O comando não
modifica firewall, persistência, SSH, DNS, OCI ou o bundle original.

São mantidos os mesmos gates da limpeza histórica: run fixo, mesmo boot,
manifest/journal coerentes, script e backups íntegros, IPv6 igual ao snapshot
`before`, persistência igual ao bundle, units de propriedade comprovada,
hashes e caminhos correspondentes, quiescência, prazo zero e ausência de jobs.
Evidência positiva de execução da service continua impedindo a operação.

A diferença é limitada à evidência IPv4: compara-se o estado atual com o hash
explicitamente aceito pelo operador. Essa comparação cobre somente a tabela
IPv4 `filter`; não comprova preservação desde a janela antiga, outras tabelas
ou conectividade. Mudanças no hash interrompem a execução e a retomada.

## Registro e retomada

O comando reutiliza o lock global e a sequência durável de remoção, reload e
arquivamento do reconciliador, incluindo releituras antes de cada remoção,
intenção antes de unlink, archive exclusivo sincronizado e validação do archive
antes de retirar o apontador. A execução produz seus próprios arquivos privados:

- `administrative-closure-f15efb347860c80f9271.json`;
- `active.administratively-closed-f15efb347860c80f9271.json`.

Qualquer evidência ou archive da reconciliação histórica impede iniciar este
caminho. O hash IPv4 aceito e o link do registro de autorização ficam fixados
na primeira evidência; não podem ser trocados para contornar uma divergência.
Nas retomadas, usar os mesmos argumentos, código revisado e autorização.

O resultado público é `administratively_closed`, com
`prior_ipv4_preservation_proven: false`. Na evidência privada, `phase: complete`
refere-se à sequência de limpeza, sempre acompanhado de
`operation_kind: administrative-closure-current-ipv4-accepted` e da mesma
negação de comprovação histórica. O journal original permanece byte a byte
em `rollback_incomplete`; não reescrever seu histórico como rollback comprovado.

## Comando proposto

Após autorização específica vinculada ao SHA do código, ao run, ao hash IPv4
atual e às ações de limpeza:

```text
python3 -B -m scripts.network_security.administrative_close close \
  --state-dir /var/lib/stk-ipv6 \
  --run-id f15efb347860c80f9271 \
  --reviewed-current-ipv4-sha256 <sha256-da-observacao-atual-aceita> \
  --approval-reference <url-do-comentario-com-a-autorizacao> \
  --acknowledge-missing-historical-ipv4 \
  --execute-reviewed-linux
```

Os dois flags são obrigatórios, assim como Linux/root e o diretório fixo.
A URL é validada como referência a comentário deste projeto, mas o programa
não autentica a autorização nem consulta o GitHub. O operador confere o texto,
SHA, escopo e vigência antes da execução; fornecer flags não concede permissão.

Antes da primeira mutação, preservar cópia privada externa do bundle,
apontador e observação atual, com hashes conferidos. Revalidar SSH, segundo
acesso administrativo e recuperação. Não transferir nem executar outro código
no caminho usado pelo rollback original. Registrar também os hashes dos três
módulos usados (`ipv6_guard.py`, `reconciliation.py`, `administrative_close.py`).

Em falha, preservar registros e unidades remanescentes. Não apagar evidência,
trocar o hash aceito, alterar journal ou usar remoção manual como atalho.
O arquivo de evidência permite retomar a mesma operação; inconsistência exige
nova avaliação. Uma janela de hardening, DNS ou implantação requer autorização
própria depois deste encerramento, sem herdar sucesso histórico inexistente.

## Verificação local

As simulações estão em `test_administrative_close.py`. A integração herda os
14 cenários de limpeza do reconciliador, aplicados à política administrativa,
em `integration_administrative_close.py`. Ela usa systemd real somente dentro
de container descartável, com firewall/persistência fictícios, rede desativada,
cgroup privado e checkout somente leitura. A allowlist do fixture recusa
comandos de firewall e outras operações fora de systemctl/busctl.

Seguir o preparo de container em [RECONCILIATION.md](RECONCILIATION.md) e executar:

```text
docker exec <container-descartavel> python3 -B -m unittest \
  scripts.network_security.integration_reconciliation \
  scripts.network_security.integration_administrative_close -v
```

Resultados e leitura de produção sem mutação em
[M0-22-VALIDATION.md](../../docs/M0-22-VALIDATION.md).
