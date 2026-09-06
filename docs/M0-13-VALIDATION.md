# STK-M0-13 — R2 e recuperação externa

Data: 2026-09-06. Base: `f7e4d3e2e2e24ad53fb29e0d7c9deae7ee2c189f`.
Implementação e verificação direta pelo Codex, conforme orientação do proprietário.

## Recursos reais

- R2 ativado após autorização específica e etapa de pagamento concluída pelo proprietário.
- Buckets `stakeframe-attachments` e `stakeframe-backups`, Standard, com acesso
  público desabilitado e sem domínio público.
- Token de conta `stakeframe-backups-m0`, operações de objetos somente no
  bucket de backups, autorizado por 30 dias, até 2026-10-06.
- Credenciais S3 salvas fora do Git, com ACL somente do proprietário/SYSTEM.
  Valores, identificador da conta e dados de cobrança ausentes desta evidência.

## Ensaio externo executado

Execução `stk-recovery-1156807dee784c22af2cac8a41cb0ec5`, concluída em
2026-09-06 às 23:03:18 UTC, Linux AMD64 via Docker Desktop. As 17 etapas,
incluindo limpeza local, passaram. Relatório sanitizado em
`.cache/recovery-reports/<run-id>.json` e cópia no arquivo privado do ensaio.

| Medida                             | Resultado |
| ---------------------------------- | --------- |
| Execução completa                  | 91,931 s  |
| Backup e envio do bundle           | 7,435 s   |
| Restauração e comparação de estado | 13,416 s  |

- Origem e destino PostgreSQL 18.4 novos, em rede interna, sem portas públicas
  ou credenciais R2. Somente a ferramenta descartável tem saída para armazenamento.
- Tentativa de leitura com o token no bucket de anexos recusada por acesso negado.
- Dump integral, roles sem hashes de senha, manifesto e checksums criptografados
  pelo Restic 0.19.1 antes do envio a um prefixo exclusivo de teste no R2.
- Dump parcial recusado sem criar snapshot. `restic check --read-data` aprovado;
  packs brutos baixados do serviço têm hash correto e não contêm o marcador
  fictício em texto legível.
- Origem parada antes da restauração externa. Senha errada e `latest` recusados
  sem criar banco de destino. Restauração pelo ID completo preserva dados,
  proprietários, ACLs, grants, constraints, sequência e ausência de hashes de senha.
- Banco já ocupado recusado sem alteração. Comando de corrupção recusado para R2.
- Containers, redes, volume local e arquivos efêmeros removidos após conferir
  nomes, labels e caminhos. Snapshot fictício mantido no R2; chave de recuperação
  preservada em diretório privado fora do Git antes do primeiro upload.

Uma tentativa inicial parou antes do upload ao esperar a rede de saída antes
do primeiro container de ferramentas. A verificação foi ajustada ao ciclo de
criação do Compose; os recursos dessa tentativa foram limpos.

## Regressões e limites

Testes de segurança cobrem destino canônico, bucket/prefixo fixos, arquivo
privado externo ao workspace, CRLF, conteúdo inválido e symlinks. O caso de
symlink de arquivo executa no Linux da CI; é pulado no Windows por depender
de permissão específica do sistema. A CI continua usando somente fixtures e
armazenamento local. Resultados por head ficam na PR antes da decisão de merge.

Regressão local aprovada: sete testes de segurança (mais um caso reservado ao
Linux), as 14 etapas do ensaio local original, tipos, lint, 60 testes unitários
da aplicação e build. Nenhuma alteração de schema ou dependência JavaScript.

Os tempos acima medem uma amostra pequena e fictícia. Não comprovam RPO de uma
hora, RTO de quatro horas, backup de produção ou funcionamento na VPS. Não
houve upload de banco real, ativação de agendamento, retenção, alertas, anexos,
OmniRoute, deploy ou migração de produção. M0 permanece em andamento.

Procedimento, custódia da chave e validade da credencial em [R2.md](R2.md).
