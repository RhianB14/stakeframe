# STK-M0-06 — reconciliação controlada

O reconciliador limpa somente os dois unit files adquiridos pelo run
`f15efb347860c80f9271` em `rollback_incomplete` e arquiva os bytes de `active.json`.
Ele não modifica firewall, persistência, script, manifest ou journal originais.
Esta implementação não foi instalada nem executada na VPS. A issue #11 continua
aberta; execução operacional depende de autorização específica.

## Execução proposta

```text
python -m scripts.network_security.reconciliation status --state-dir <diretório-privado> --run-id f15efb347860c80f9271

python -m scripts.network_security.reconciliation reconcile \
  --state-dir /var/lib/stk-ipv6 \
  --run-id f15efb347860c80f9271 \
  --ipv4-evidence /var/lib/stk-ipv6/external/ipv4-f15efb347860c80f9271.json \
  --execute-reviewed-linux
```

`reconcile` exige Linux/root, flag explícita e o diretório fixo. O reconciliador
novo é executado separadamente do bundle antigo; seu hash não substitui
`script_sha256` do manifest. O mesmo `operation.lock` global protege todas as
etapas, com timeout. `status` não reconcilia nem substitui os readbacks; apenas
lê os registros sob esse lock. O Store pode criar o diretório/arquivo de lock.

## Referência IPv4 anterior

O documento e seu arquivo de dados ficam fora do bundle e devem ser arquivos
regulares privados, pertencentes ao usuário efetivo, sem symlinks. Exemplo de
estrutura, com valores fictícios que precisam ser substituídos por evidência real:

```json
{
  "schema": 1,
  "source": "external-private-observation",
  "run_id": "f15efb347860c80f9271",
  "boot_id": "<boot-original>",
  "manifest_sha256": "<hash-do-manifest-original>",
  "observed_monotonic_ns": 123,
  "active_sha256": "<hash-dos-bytes-anteriores>",
  "data_file": "ipv4.active"
}
```

`data_file` é um basename adjacente ao documento. Seus bytes devem corresponder
à saída anterior de `iptables -w 5 -t filter -S`; a leitura atual usa esse mesmo
formato e compara SHA-256. Essa comparação cobre a tabela IPv4 **filter**, não
outras tabelas nem testes de conectividade.

`observed_monotonic_ns` deve ser inteiro positivo (booleano não é aceito) e
obedecer `observed_monotonic_ns <= prepared_monotonic_ns <= relógio atual` no
mesmo boot. A preparação é o limite imutável garantidamente anterior ao apply;
`applied_monotonic_ns`, gravado depois das mutações, não serve como limite seguro.
Uma observação posterior à preparação precisa de avaliação operacional separada;
o reconciliador não flexibiliza essa condição nem recria uma observação antiga.

Os campos canônicos dessa referência, incluindo timestamp, basename e hash dos
dados, são fixados na primeira evidência durável de reconciliação e comparados
nas retomadas e no no-op. Trocar a referência para corresponder a um IPv4 alterado
é recusado. Hash, permissões e vínculos verificam integridade e consistência; não
autenticam por si sós a alegação humana sobre quando os bytes foram coletados.
Sua procedência precisa ser conferida antes de autorizar a operação. Não criar
uma referência “anterior” a partir do estado atual.

## Verificações e retomadas

Antes das remoções são conferidos identidade, boot, journal/manifest, hashes do
script, backup e units originais, registro de aquisição/instalação, snapshot IPv6
`before`, persistência e referência IPv4. Unidade presente exige `FragmentPath`
e bytes correspondentes ao bundle. Symlink, diretório ou outro tipo inesperado
é colisão; somente ausência física por `lstat` pode ser tratada como ausência.

Cada novo unlink é precedido por uma nova conferência desses vínculos e da
quiescência de service/timer, prazo zero e jobs (lista global e propriedade
`Job`). Timestamp inválido, execução positiva conhecida ou estado desconhecido
recusa a operação. Uma unidade já removida pode estar `not-found` somente se a
intenção durável e a ausência física estiverem vinculadas; isso não fabrica um
timestamp de execução zero.

1. Gravar evidência privada separada, schema 3, com hashes e referência IPv4 fixa.
2. Gravar `remove-intent` antes de cada remoção; depois verificar ausência física,
   sincronizar o diretório e registrar `unlinked`.
3. Executar `daemon-reload` e exigir units fisicamente ausentes, `not-found`,
   `inactive/dead` e nenhum job. Um unit ainda `loaded` após unlink não é conclusão.
4. Revalidar estado operacional e gravar limpeza verificada antes de arquivar.
5. Gravar intenção de archive. Publicar bytes completos e sincronizados por link
   exclusivo de arquivo temporário privado, sem sobrescrever destino existente.
6. Conferir archive e gravar `archive-created`. Em toda retomada, reconferir tipo,
   permissões, identidade, tamanho e bytes/hash do archive **antes** de remover
   `active.json`, além de revalidar as condições operacionais.
7. Remover o apontador, sincronizar o diretório, conferir novamente o archive e
   registrar `archived`. Somente a verificação final permite `complete`.

São recuperáveis interrupções após evidência, unlink, reload, publicação do
archive, registro `archive-created` e remoção do apontador. Archive ausente ou
corrompido após criação comprovada interrompe a retomada e preserva o apontador
quando ele ainda existe. Arquivo já existente sem intenção anterior é colisão,
mesmo com bytes iguais. Falha durante escrita temporária nunca publica archive
parcial; uma morte abrupta pode deixar um temporário privado órfão, que não é
adotado nem apagado por inferência.

O no-op revalida os vínculos e a referência original, restauração, bundle,
archive e limpeza atual. Não é inferido da ausência de arquivos. Evidência de
schema anterior é recusada, sem migração automática ou alteração do journal.
O lock coordena os comandos da aplicação; as releituras detectam mudanças externas
observáveis, mas não constituem uma transação com administradores externos.

## Validação local com systemd

O proprietário autorizou o Codex a implementar o complemento. Foram executados
112 testes de simulação e 14 testes de integração da reconciliação em Ubuntu
24.04/systemd 255, com namespace de cgroup privado, rede desativada e código
montado somente leitura. Firewall e persistência são fictícios; uma allowlist
bloqueia chamadas fora de systemctl/busctl no adaptador do fixture.

A integração cobre as interrupções, archive ausente/corrompido, symlink residual,
ativação real da service entre unlinks, colisão de instalação e no-op. Referências
D-Bus do fixture mantêm unidades válidas carregadas sem iniciar a service no caso
normal; o teste verifica explicitamente `loaded` após unlink e `not-found` após
reload. Outro cenário retoma após uma unidade removida já ter sido descarregada.
Essas referências são suporte de teste, não comprovação de histórico em produção.

```bash
# Usar imagem e nome de container exclusivos para esta execução local.
docker build -f scripts/network_security/Dockerfile.reconciliation-systemd \
  -t stk-reconciliation-test .
docker run -d --name stk-reconciliation-test --privileged --cgroupns private \
  --network none --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
  --mount type=bind,source=<checkout-absoluto>,target=/review,readonly \
  -e STK_DISPOSABLE_SYSTEMD=1 stk-reconciliation-test
docker exec stk-reconciliation-test cat /proc/1/comm
docker exec stk-reconciliation-test systemctl --version
docker exec stk-reconciliation-test python3 -B -m unittest discover \
  -s scripts/network_security -p 'test_*.py' -q
docker exec stk-reconciliation-test python3 -B -m unittest \
  scripts.network_security.integration_reconciliation -v
# Remover somente o container descartável criado para esta execução.
docker rm -f stk-reconciliation-test
```

Sem opt-in, Linux/root, Docker e systemd como PID 1, a integração é ignorada pelo
unittest. Executar o módulo diretamente exige esses pré-requisitos e recusa a
ausência deles. A CI comum executa as simulações; o teste real é local e explícito.
Não montar `/sys/fs/cgroup` do host nem compartilhar seu namespace. Nenhum teste
valida firewall real, ARM64, recuperação de acesso ou a futura janela na VPS.
