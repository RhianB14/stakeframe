# Recuperação de desastre

> **STATUS: NÃO IMPLEMENTADO E NÃO VALIDADO.** Descreve a estratégia aprovada
> e a estrutura do procedimento futuro. Nenhum teste de restauração foi
> executado.

## Objetivos (do plano mestre)

- **RPO máximo: 1 hora** — backups externos criptografados a cada 30 minutos,
  com alerta quando o último backup válido ultrapassar 1 hora.
- **RTO máximo: 4 horas** — considerando servidor disponível e atuação do
  operador.

## Estratégia aprovada (decisão D009)

### Banco de dados (PostgreSQL)

- Backup **lógico completo** com `pg_dump` em formato custom (`-Fc`), do banco
  inteiro, executado por agendamento a cada 30 minutos.
- O dump é **criptografado antes de sair da VPS** e enviado ao bucket privado
  de backups no Cloudflare R2.
- A restauração usa `pg_restore` em um cluster PostgreSQL recém-provisionado,
  seguida de **recriação das roles e permissões** necessárias (a restauração
  lógica não recria papéis de instância): recriar a role da aplicação a partir
  de segredo gerenciado e reaplicar os grants do schema.
- **Sem PITR nesta etapa.** Backup físico com arquivamento de WAL
  (point-in-time recovery) fica fora do M0 e dependerá de decisão futura;
  nenhum procedimento deste documento depende de WAL.

### Anexos (Cloudflare R2)

- Sem dependência de versionamento nativo do bucket. Cada objeto recebe
  **identificador único** (ex.: UUID) e **nunca é sobrescrito**; uma nova
  versão de um anexo é um objeto novo.
- Uma **cópia de recuperação** de cada objeto é mantida no bucket privado de
  backups, gravada na mesma janela dos dumps.
- **Manifesto de objetos com checksums** (SHA-256 por objeto + lista do
  intervalo) é gerado junto com cada ciclo, permitindo conferir a restauração
  objeto a objeto.
- A **política de exclusão de anexos expirados aplica-se também às cópias de
  recuperação**, impedindo que a restauração reintroduza imagens cuja
  retenção expirou.

| Componente                      | Backup                                              |
| ------------------------------- | --------------------------------------------------- |
| PostgreSQL                      | Dump lógico completo (`pg_dump -Fc`), criptografado |
| Anexos                          | Objetos imutáveis + cópia no bucket de backups      |
| Manifesto de anexos             | Lista + checksums por ciclo de backup               |
| Configuração do OmniRoute       | Backup do volume de configuração                    |
| Compose e configuração de infra | Versionados no repositório                          |

- Retenção: cópias frequentes por 48 horas; diárias por 30 dias.
- Chave de recuperação guardada **fora da VPS**.
- A restauração deve reaplicar as regras de retenção de anexos (não
  reintroduzir imagens expiradas), inclusive nas cópias de recuperação.

## Procedimento de restauração (a implementar e testar)

1. Provisionar/recriar a VPS.
2. Restaurar o dump PostgreSQL mais recente válido com `pg_restore`.
3. Recriar roles e permissões do banco.
4. Restaurar anexos a partir das cópias de recuperação e conferir contra o
   manifesto (checksums) e a política de retenção.
5. Restaurar configuração do OmniRoute.
6. Subir o compose com as imagens por digest.
7. Verificação de integridade (conciliação de saldos, contagens, smoke tests).
8. Registro do teste (data, duração, RTO medido, problemas).

## Métricas que a validação futura deve medir

- **Idade do snapshot recuperável** (tempo entre o dump válido mais recente e
  o momento da falha — deve ser compatível com o RPO de 1 hora).
- Duração do backup e do upload.
- Duração total da restauração (base de cálculo do RTO real).

## Testes exigidos antes de considerar o M0 concluído

- [ ] Restauração completa executada com sucesso ao menos uma vez, incluindo
      recriação de roles e conferência de anexos por manifesto.
- [ ] Alerta de backup atrasado verificado.
- [ ] Teste mensal de restauração agendado e documentado.

Nenhum item acima foi executado. Este documento não descreve capacidade real —
descreve compromissos a implementar.
