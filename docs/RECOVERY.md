# Recuperação de desastre

> **STATUS: NÃO IMPLEMENTADO E NÃO VALIDADO.** Descreve os objetivos e a
> estrutura do procedimento futuro. Nenhum teste de restauração foi executado.

## Objetivos (do plano mestre)

- **RPO máximo: 1 hora** — backups externos criptografados a cada 30 minutos,
  com alerta quando o último backup válido ultrapassar 1 hora.
- **RTO máximo: 4 horas** — considerando servidor disponível e atuação do
  operador.

## Estrutura planejada

| Componente                      | Backup                                            |
| ------------------------------- | ------------------------------------------------- |
| PostgreSQL                      | Dump lógico + WAL, criptografado, → Cloudflare R2 |
| Anexos                          | Bucket R2 com versionamento                       |
| Configuração do OmniRoute       | Backup do volume de configuração                  |
| Compose e configuração de infra | Versionados no repositório                        |

- Retenção: cópias frequentes por 48 horas; diárias por 30 dias.
- Chave de recuperação guardada **fora da VPS**.
- A restauração deve reaplicar as regras de retenção de anexos (não
  reintroduzir imagens expiradas).

## Procedimento de restauração (a implementar e testar)

1. Provisionar/reesperar a VPS.
2. Restaurar backup do PostgreSQL mais recente válido.
3. Restaurar anexos e configuração do OmniRoute.
4. Subir o compose com as imagens por digest.
5. Verificação de integridade (conciliação de saldos, contagens, smoke tests).
6. Registro do teste (data, duração, RTO medido, problemas).

## Testes exigidos antes de considerar o M0 concluído

- [ ] Restauração completa executada com sucesso ao menos uma vez.
- [ ] Alerta de backup atrasado verificado.
- [ ] Teste mensal de restauração agendado e documentado.

Nenhum item acima foi executado. Este documento não descreve capacidade real —
descreve compromissos a implementar.
