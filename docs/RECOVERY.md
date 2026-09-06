# Recuperação de desastre

> **STATUS: VALIDAÇÃO PARCIAL COM DADOS FICTÍCIOS.** STK-M0-10 demonstra dump
> criptografado local; STK-M0-13 demonstra envio ao R2 e restauração em cluster novo.
> Evidências externas em [M0-13-VALIDATION.md](M0-13-VALIDATION.md). Backups
> externos da aplicação, agendamento, alertas e recuperação completa de produção
> continuam pendentes. Evidências e limites em [RECOVERY-DRILL.md](RECOVERY-DRILL.md).

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
- A restauração começa pela preparação do PostgreSQL de destino: provisionar
  o cluster e preparar o banco de destino. As **roles referenciadas no dump
  são recriadas previamente**, pois a restauração lógica não recria papéis de
  instância; credenciais são fornecidas fora do repositório. Depois, executar
  `pg_restore --exit-on-error` usando uma conta com as permissões necessárias
  para restaurar objetos, proprietários e ACLs. Ao final, conferir
  proprietários e permissões antes de prosseguir com os anexos e as demais
  verificações.
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

## Procedimento de restauração de produção (a implementar e testar)

1. Provisionar/recriar a VPS e preparar o cluster PostgreSQL de destino.
2. Selecionar o dump PostgreSQL válido mais recente, recriar previamente as
   roles referenciadas nele e preparar o banco de destino; credenciais são
   fornecidas fora do repositório.
3. Executar `pg_restore --exit-on-error` usando uma conta com as permissões
   necessárias para restaurar objetos, proprietários e ACLs.
4. Conferir proprietários e permissões após a restauração.
5. Restaurar anexos a partir das cópias de recuperação e conferir contra o
   manifesto (checksums) e a política de retenção.
6. Restaurar configuração do OmniRoute.
7. Subir o compose com as imagens por digest.
8. Verificação de integridade (conciliação de saldos, contagens, smoke tests).
9. Registro do teste (data, duração, RTO medido, problemas).

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

O ensaio local valida somente a parte PostgreSQL com roles e permissões, usando
Restic e dados de teste. Ele não conclui nenhum dos itens integrais acima.
Veja [M0-10-VALIDATION.md](M0-10-VALIDATION.md) para a evidência executada.
O [ensaio R2](R2.md) acrescenta armazenamento externo real e chave preservada
fora da VPS, ainda com dados fictícios e sem ativar a operação de produção.
