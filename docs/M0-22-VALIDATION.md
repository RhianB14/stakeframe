# STK-M0-22 — preparo de encerramento administrativo

Codex implementou e verificou diretamente, sob a diretriz temporária de
`AGENTS.md`. A preparação da [issue #53](https://github.com/RhianB14/stakeframe/issues/53)
foi seguida de autorização e execução na VPS. Os registros abaixo distinguem
o resultado operacional da preparação anterior; sem revisão independente do GitHub.

## Execução autorizada — 07/09/2026

[Autorização de Rhian](https://github.com/RhianB14/stakeframe/issues/53#issuecomment-5569617161)
vinculada ao head `f52fb13a60f77ffb6b9a47b8f5eebf801cb52c43` da PR #54,
integrada na main `afc07b5e0af65c179123946282f5ff9989fd5604` com tree idêntico.
Os cinco checks da PR e da main passaram antes da execução.

O comando retornou `administratively_closed`, `noop: false`, às 11:03:23 UTC.
O staging exclusivo aprovado contém os três módulos com hashes conferidos,
diretório 0700 e arquivos 0600 root. Segundo acesso SSH administrativo mantido
durante a operação. Getty ativo foi observado; não equivale a console
independente estabelecido para uma janela futura de firewall.

Nova leitura SSH às 11:04:22 UTC confirmou:

- Duas units removidas e nenhum job residual.
- Seis arquivos originais com hashes inalterados; journal byte a byte em
  `rollback_incomplete`.
- Apontador ativo ausente; archive com os mesmos bytes e SHA-256
  `dd00cd0d0a8b3c014e8db55cfe2bc17356566baae36d70462fd53667c7b9f9ed`.
- IPv4 atual igual ao hash aceito; IPv6 e persistência iguais ao estado anterior.
- Evidência administrativa de SHA-256
  `b0754cbe2c8cc9440a5f9aa43e4412c908349564266c69a32342ea69c621488b`,
  com `operation_kind: administrative-closure-current-ipv4-accepted` e
  `prior_ipv4_preservation_proven: false`.
- Sete arquivos anteriores e os dois registros novos preservados em custódia
  privada externa; hashes dos novos registros conferidos após releitura local.

A [issue #53 foi encerrada](https://github.com/RhianB14/stakeframe/issues/53#issuecomment-5569668467).
A lacuna histórica permanece; não houve alteração de firewall, persistência,
DNS, OCI, SSH, credenciais, deploy ou migração. A nova janela da issue #11
tem preparo e autorização próprios em [NEXT-NETWORK-WINDOW.md](NEXT-NETWORK-WINDOW.md).

## Evidência anterior à execução, sem mutação

Leitura SSH em 07/09/2026 às 10:25:23 UTC, com chave e host conhecidos,
`StrictHostKeyChecking=yes`, comandos de leitura e módulos executados em memória:

| Gate                                  | Resultado                                                    |
| ------------------------------------- | ------------------------------------------------------------ |
| Run                                   | `f15efb347860c80f9271`, `rollback_incomplete`                |
| Boot e apontador                      | Mesmo boot; `active.json` identifica o run                   |
| Manifest, journal, script e backup    | Vínculos e hashes conferidos                                 |
| IPv6 e persistência                   | Iguais ao `before` e aos hashes do bundle                    |
| Duas units residuais                  | Adquiridas/instaladas pelo run, arquivos e caminhos corretos |
| Estado systemd                        | `loaded`, `inactive/dead`, quiescência aceita e nenhum job   |
| Reconciliação/encerramento anteriores | Sem evidência ou archive desses procedimentos                |
| Histórico IPv4                        | Sem comprovação anterior ao `prepare`                        |

SHA-256 da tabela IPv4 `filter` atual:
`af7e02d4cdf781f514079d3842027c015593a80775e930d727c482fec4c2a8ca`.
Essa é uma observação atual, preservada privadamente fora do Git; não foi
transformada em referência anterior à preparação.

Manifest original:
`00a7e64abba5350a9085b39521dd5634d1c19759b703603685a6b46a222ac391`.
Journal original:
`13c8cd25f516f666c8c49625bd5568f0cc6c4e67bb3486ab4d8c07ae708b6e8e`.
Apontador original:
`dd00cd0d0a8b3c014e8db55cfe2bc17356566baae36d70462fd53667c7b9f9ed`.

O probe não criou diretório/lock no servidor, não copiou código para disco e
não alterou firewall, persistência ou units. O estado deve ser conferido de
novo antes de qualquer execução autorizada.

## Testes locais

- 130 simulações aprovadas, incluindo os 112 testes existentes e 18 testes da
  nova política administrativa, com seis pontos de interrupção/retomada.
- 28 testes de integração aprovados em Ubuntu 24.04/systemd 255: 14 cenários
  do reconciliador histórico e os mesmos 14 aplicados ao encerramento novo.
- Integração em container descartável, rede desativada, cgroup privado e
  checkout somente leitura. Firewall e persistência fictícios; a allowlist
  impede comandos reais de firewall no fixture.

Os testes cobrem deriva de IPv4, preservação dos gates IPv6/persistência,
mudança de boot, execução da service, timer pendente, hashes e colisões de
units, evidências incompatíveis, troca de autorização/hash em retomada,
archive ausente/corrompido e recusa de alegação falsa de preservação histórica.
Não comprovam conectividade, firewall real ou execução em produção.

## Ação operacional proposta

Após review do SHA e autorização específica: preservar cópia externa privada
dos registros; executar somente o
[encerramento administrativo](../scripts/network_security/ADMINISTRATIVE-CLOSE.md)
do run acima, aceitando o hash IPv4 atual discriminado; remover somente seus
dois arquivos de unit em `/run/systemd/system`, executar `daemon-reload` e
arquivar `active.json` com evidência própria e releitura verificada.

O journal original mantém `rollback_incomplete`; o resultado declara
`administratively_closed` e `prior_ipv4_preservation_proven: false`.
Não inclui firewall, DNS, OCI, SSH, reboot, credenciais, deploy ou migração.
A implementação integrada, CI verde ou uma referência de URL não autorizam
essa execução. A issue #11 permanece operacionalmente pendente.
