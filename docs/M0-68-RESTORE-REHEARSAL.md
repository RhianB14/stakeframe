# STK-M0-68 — ensaio de restauração real

**Data:** 13/09/2026  
**Classificação:** OPERACIONAL — ensaio isolado aprovado

## Escopo e autorização

Foi executada uma única restauração de ensaio, autorizada pelo Codex, usando o
backup real mais recente do R2. O destino foi um cluster PostgreSQL novo, em
rede Docker interna e sem portas publicadas. A credencial usada pelo runner é
somente de leitura; produção não foi parada, recriada ou alterada.

## Gates antes da execução

- Host de produção: `vnci110`.
- Backup: `state=ready`, retenção ativa, cutoff
  `2026-09-13T14:00:02.240Z`; o backup tinha menos de uma hora no início da
  janela (aproximadamente 19 minutos).
- Disco disponível para o Docker: mais de 41 GB livres (19% usado), acima do
  limite de 10 GiB/20% do procedimento.
- Serviços `api`, `worker`, `web`, `operations` e `postgres`: running/healthy;
  nenhum restart; nenhum runner, container, rede ou volume de restore residual.
- Node 24.20.0, runner, configuração Docker e os três arquivos de segredo
  existentes com permissões canônicas; nenhum valor foi lido ou registrado.
- Serviço de restore inativo e sem janela concorrente de backup/restauração.

## Execução

O comando do runbook foi executado uma vez, sem prompt, com o marcador de
confirmação `monthly-isolated-recovery` e `DOCKER_CONFIG` privado. O runner
selecionou o snapshot `c328d16a6611…` e concluiu em
`2026-09-13T14:19:17.027Z`.

Resultado do relatório privado:

- `status=passed` e `cleanup=passed`;
- `countsVerified=true` e `financeVerified=true`;
- `rolesVerified=true` e `permissionsVerified=true`;
- `importsPaused=true` e `sessionsRevoked=true`;
- duração do runner: **29.526 s** (`durationMs=29526`).

O backup indicava um objeto de imagem no manifesto (`imageCount=1`, 23.877
bytes). A restauração executou a verificação de checksums/manifesto prevista
no runner; nenhum conteúdo de imagem ou segredo foi exposto neste registro.

## Métricas e pós-validação

- **RPO medido:** 19 min 14,787 s entre o cutoff do snapshot e a conclusão do
  ensaio — dentro do objetivo de 1 hora.
- **RTO medido:** 29,526 s de restauração do cluster isolado — dentro do
  objetivo de 4 horas.
- Containers, redes e volumes com a etiqueta do ensaio após a execução: zero.
  `/run/stakeframe-restore` ficou ausente.
- Produção permaneceu intacta: os cinco serviços continuaram
  running/healthy, com `restart=0` e mesmos horários de início; o PostgreSQL
  continuou sem restart.
- Contagens antes/depois na produção foram idênticas: bets 2, postings 11,
  journals 5, settlements 1, freebets 0, inbox 1, attachments 1,
  extraction requests 0 e event search 1.
- O estado do backup permaneceu `ready`, com o mesmo cutoff e retenção ativa.

## Conclusão e limites

O ensaio real de restauração em cluster isolado foi aprovado, comprovando
integridade de contagens/finanças, roles, permissões, manifesto de anexos e
limpeza do ambiente. O resultado mede a restauração lógica com o servidor
disponível; não é um failover e não autoriza qualquer alteração de produção.

Permanece pendente no plano o alerta de backup atrasado. Renovação automática
do certificado, RPO/RTO de um failover completo e outras tarefas não foram
alterados por esta janela.

Não houve deploy, migração, restart, leitura de segredos, escrita no R2,
alteração de banco de produção ou acesso às integrações.
