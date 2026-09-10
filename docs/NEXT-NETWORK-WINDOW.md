# Próxima janela IPv6 — STK-M0-23

> **STATUS: JANELA EXECUTADA E CONFIRMADA EM 07/09/2026.** Este documento
> preserva o **plano histórico** que foi autorizado e executado; ele **não**
> descreve mais uma aplicação futura. Resultado real, escopo normalizado do
> delta, estado terminal de timer/service e limitações estão em
> [M0-31-VALIDATION.md](M0-31-VALIDATION.md). Um preflight posterior
> (10/09/2026) ainda tratava a janela como futura e abortou por premissa
> vencida, sem executar prepare, apply ou confirm.

O encerramento administrativo do run legado está concluído. Esta proposta
prepara uma nova execução do guard para a [issue #11](https://github.com/RhianB14/stakeframe/issues/11),
acompanhada pela [issue #55](https://github.com/RhianB14/stakeframe/issues/55).
Não houve novo prepare, transferência, credencial ou aplicação nesta preparação.
Codex preparou e verificou diretamente; sem revisão independente do GitHub.

## Código e estado conferidos

Fonte: main `afc07b5e0af65c179123946282f5ff9989fd5604`, CI
[34112198853](https://github.com/RhianB14/stakeframe/actions/runs/34112198853)
com cinco checks aprovados. O guard permanece sem alterações, SHA-256:
`63b0ce735a73e3526aa4df3947278c17a2fb92b961d9f313eb5e6251991111bf`.
As 130 simulações e 28 integrações com systemd da PR #54 são evidência local;
não comprovam aplicação ou conectividade real desta próxima janela.

Leitura da VPS em 07/09/2026 às 12:09:50 UTC, por SSH com host conhecido,
somente leitura e módulo executado em memória, sem criar arquivo ou lock remoto:

| Verificação             | Resultado                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Host/backend            | Ubuntu 24.04 ARM64 e ip6tables 1.8.10 nf_tables aceitos pelo adaptador               |
| Run antigo              | Evidência administrativa completa; apontador ativo ausente                           |
| IPv6                    | INPUT/FORWARD/OUTPUT ACCEPT; INPUT vazio                                             |
| Colisões                | Nenhuma chain STK6, arquivo de unit stk6 ou unit stk6 carregada                      |
| Leitura de dependências | Rotas, endereços, listeners, Docker, Fail2Ban, DNS, relógio e persistência coletados |
| Recuperação para apply  | Não estabelecida; getty ativo não atende o gate                                      |

A linha da recuperação descreve a leitura **naquele instante**. Na janela
executada em 07/09/2026 a condição foi satisfeita: a atestação de preflight
registra operador em sessão serial e os checks de recuperação do provedor
aprovados ([M0-31-VALIDATION.md](M0-31-VALIDATION.md) §2 e §6).

Snapshot completo e saídas permanecem privados fora do Git, com hashes
conferidos. A tabela IPv4 filter mantém SHA-256
`af7e02d4cdf781f514079d3842027c015593a80775e930d727c482fec4c2a8ca`.
Os hashes brutos de iptables-save identificam cada captura, mas seus comentários
de horário e estado dinâmico impedem usá-los isoladamente como teste de drift.
Na janela, comparar regras/políticas normalizadas, preservando os bytes originais.

## Escopo proposto para autorização (executado em 07/09/2026)

1. Estabelecer conexão temporária de console OCI pelo caminho já validado em
   [ACCESS-RECOVERY.md](ACCESS-RECOVERY.md). Registrar somente os recursos
   criados pela janela. O proprietário digita a credencial temporária do guest
   no terminal privado; nenhum segredo entra em chat, argumentos ou logs.
   Conferir sessão serial autenticada, tty e sudo root e mantê-la durante apply.
   Capturar privadamente o estado anterior da conta para restauração exata.
2. Manter SSH original e outro acesso administrativo independente. Revalidar
   identidade, mesmo boot, backend, INPUT vazio, persistência e ausência de
   colisões. Preservar o bundle e os registros administrativos antigos.
3. Criar staging exclusivo `/root/stk-ipv6-staging-m0-23`, 0700 root, com
   somente `ipv6_guard.py` 0600 e hash acima. Divergência ou diretório existente
   interrompe a criação; não sobrescrever staging de outra execução.
4. Antes de prepare, capturar IPv4 filter e snapshot completo no mesmo guest,
   com boot e instante monotônico reais. Guardar cópia privada externa e
   conferir hashes. Executar prepare com run novo e janela de 600 segundos,
   no diretório global `/var/lib/stk-ipv6`; guardar os seis arquivos do novo
   bundle no servidor e fora dele, com conferência por arquivo.
5. Vincular a observação IPv4 anterior ao run e hash do novo manifest, sem
   substituir o instante original: `observed_monotonic_ns` deve ser menor que
   `prepared_monotonic_ns`. Preservar os bytes originais ao lado dos metadados.
   Essa referência pertence à nova janela e não preenche a lacuna do run antigo.
6. Preencher atestação preflight somente com evidências reais e atuais para
   cada check de `plan`, incluindo console mantido e cópias do bundle. Registrar
   referência de autorização, SHA do JSON e validade monotônica. Falta de
   evidência ou expiração impede apply; não preencher pass por conveniência.
7. Executar apply, armando o timer monotônico antes do delta. A mudança é a
   matriz de [NETWORK-SECURITY.md §4](NETWORK-SECURITY.md#4-delta-fechado--aplicado-e-confirmado-na-janela-de-07092026):
   INPUT em chain própria, permitindo loopback, ESTABLISHED/RELATED, ICMPv6 e
   TCP/22, terminando em DROP; INPUT/FORWARD com política DROP. Preservar
   OUTPUT, IPv4, NAT, saltos Docker, Fail2Ban, persistência, SSH e OCI.
8. Abrir nova conexão SSH independente depois de apply, executar todos os
   probes pós-alteração e registrar atestação post com tempos reais do guest.
   Confirmar apenas dentro do prazo e se todos passarem. Falha ou prazo vencido
   mantém rollback automático; não matar uma recuperação iniciada.
9. Verificar resultado real, timer/service, firewall e persistência; copiar os
   novos registros para custódia externa. Em falha, executar apenas rollback
   do delta próprio pelo guard e preservar evidências/unidades remanescentes.
   Não usar o encerrador administrativo do run antigo para este run novo.
10. Encerrar o acesso temporário: restaurar exatamente a forma anterior do
    campo de senha e metadados de envelhecimento, conferir SSH+sudo, logout
    serial e excluir somente a conexão criada nesta janela. Registrar o
    descarte ou a pendência da chave temporária sem inventar comprovação.

As invocações usam `python3 -I -B` com o mesmo arquivo revisado, flags e
argumentos descritos no [README do guard](../scripts/network_security/README.md).
Não reiniciar, instalar pacotes, persistir regras, abrir 80/443, alterar DNS,
criar IAM, implantar aplicação ou migrar banco nesta janela. Mudança de escopo,
host, backend ou código exige nova avaliação. A confirmação CLI não autoriza.

## Recuperação e interrupção

Console indisponível ou sem sudo impede apply. O teste serial anterior não
vale como sessão atual. Perda do console durante a janela impede confirmação
até haver recuperação segura; preservar o timer e usar o acesso ainda operante.
O timer reside na VPS e recupera apenas o delta IPv6 do run; não cobre OCI,
credenciais, persistência externa nem uma perda geral do host.

Se uma etapa falhar, registrar quais recursos foram criados e quais foram
restaurados. A limpeza de credencial/conexão mantém o escopo do item 10,
usando SSH independente se o serial falhar. Se também não houver SSH, registrar
limpeza pendente. Não apagar journals, archives ou bundles para liberar o gate.

## DNS e piloto depois desta janela

DNS público observado na mesma coleta: nameservers `dns3.hostgator.com.br` e
`dns4.hostgator.com.br`; um A fora da VPS, nenhum AAAA e nenhuma resposta CAA.
O navegador disponível chegou ao login da HostGator; a zona autenticada não
foi inspecionada. Antes de alterar DNS, conferir registros completos no painel,
guardar os valores anteriores e propor o diff mínimo do apex para o IPv4
conhecido. Manter MX/TXT e nameservers; não criar AAAA sem IPv6 público validado.

DNS, revisão de exposição web, provisionamento de segredos, primeira migração,
backup, monitor e piloto seguem em [FIRST-DEPLOYMENT.md](FIRST-DEPLOYMENT.md).
O encerramento desta janela não libera M0 nem v1.0.0 por si só.

## Encerramento deste plano

O plano acima foi executado em 07/09/2026: o delta IPv6 está ativo e
confirmado, o timer de rollback está desarmado e o recurso de console
temporário foi encerrado. Os itens de escopo aqui descritos deixam de ser
proposta e passam a ser registro histórico; qualquer mudança nova de rede — ou
persistência do delta — exige autorização própria
([M0-31-VALIDATION.md](M0-31-VALIDATION.md)).
