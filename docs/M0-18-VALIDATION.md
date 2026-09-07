# STK-M0-18 — Integrações e recuperação operacional

Autoria e verificação direta por Codex, conforme D019 e diretriz vigente do
proprietário. Não constitui revisão independente do GitHub. Implementação
vinculada à [issue #46](https://github.com/RhianB14/stakeframe/issues/46).

## Entrega

Overlays de produção integram OpenRouter, Telegram, R2, buscas de eventos,
backup criptografado, retenção e monitor. Tavily e importação automática têm
overlays separados; nenhuma política real de layout foi aprovada. O target
`operations` reúne Node 24.20.0, cliente PostgreSQL 18.4 e Restic 0.19.1, com
dependências de produção e execução sem root.

O backup preserva o snapshot lógico do banco, anexos locais/remotos, contagens,
saldo por conta, exposição e papéis. Imagens separadas do dump permitem exclusão
nos snapshots antigos. A restauração só aceita cluster novo, aplica expiração
atual, revoga sessões e coloca todas as integrações em quarentena. O runner
mensal utiliza leitura do R2, espaço em disco monitorado e limpeza por identidade
de recursos. Procedimento e limites em [OPERATIONS.md](OPERATIONS.md).

## Evidências locais em 07/09/2026

| Verificação                                                           | Resultado                                                                                                              |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| TypeScript, ESLint e contrato OpenAPI                                 | Aprovados                                                                                                              |
| Testes unitários                                                      | 115 aprovados                                                                                                          |
| Integração PostgreSQL, autenticação, finanças, importação e eventos   | 95 aprovados                                                                                                           |
| Verificação adicional da inbox após reforço do teste de orçamento     | 9 aprovados; bloqueio não chama geração                                                                                |
| Testes Node de monitor, política, recuperação de leitura e capacidade | 10 aprovados                                                                                                           |
| Navegador com as imagens finais, Chrome local                         | 48 aprovados, desktop e celular                                                                                        |
| Auditoria pnpm                                                        | Nenhuma vulnerabilidade conhecida encontrada                                                                           |
| Imagens API, worker e migrador sem dependências de desenvolvimento    | Aprovadas, x64                                                                                                         |
| Worker Cloudflare                                                     | Dry run aprovado; runtime local inicializa SQLite, responde ao token fictício, recusa anônimo e mantém cron desativado |

Ensaio HTTPS `stk-deploy-86321798e5774e01913d454000e0d264`: dez verificações
aprovadas, incluindo overlays, isolamento de segredos, configuração imutável,
migração explícita/repetível, papel sem superusuário, cadeia TLS válida do
ensaio, recusas de acesso, cookies seguros e persistência após reinício.
Limpeza aprovada. O certificado do ensaio não foi instalado no computador.

Ensaio de backup `stk-ops-52f47079008a4731b9751201e969a00f`: sete verificações
aprovadas, com dois bilhetes financeiros, três imagens fictícias e repositório
Restic isolado. A imagem de operações tinha 227.641.557 bytes em AMD64.
Recuperou duas imagens válidas e manteve uma expirada excluída, inclusive ao
escolher o snapshot histórico. Contagens, saldos, exposição, papéis, revogação
de sessões e quarentena conferidos. A restauração interna durou 1.345 ms neste
conjunto mínimo. Limpeza aprovada; isso não mede RTO de produção.

O mesmo ensaio demonstra recusa de chave incorreta, recusa de banco ocupado,
preservação do último cutoff recuperável durante falha de armazenamento,
exclusão dos bytes expirados em snapshots antigos e serialização de backups.
Uma consulta que usava uma coluna inexistente foi corrigida durante o ensaio;
o cenário completo foi repetido com sucesso na imagem reconstruída.

## Banco e limites

Nenhuma migração de schema nova. A política de expiração existente é
compartilhada entre worker e backup. Quando ativado, o backup pode marcar
anexos vencidos para exclusão e podar suas cópias externas; por isso a ativação
requer autorização explícita de backup e retenção, vinculada ao artefato.

O ensaio usa adaptação de armazenamento remoto fictícia, sem rede externa.
Não comprova permissões dos buckets reais. O timer systemd e o runner de host
Linux estão preparados, mas ainda não instalados/executados na VPS. A inspeção
local do monitor não publicou Worker nem enviou Telegram.

Publicação por digest, custódia/provisionamento de segredos, DNS/ACME, alertas
reais, primeiro backup externo da aplicação, ensaio mensal na VPS, custos e
piloto financeiro continuam pendentes de suas janelas autorizadas. Esta tarefa
não declara M0/M6 concluídos nem libera `v1.0.0`.
