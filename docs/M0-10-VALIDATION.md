# STK-M0-10 — Evidências do ensaio de recuperação

Data: 2026-09-06. Ambiente local: Windows com Docker Desktop/Linux AMD64;
Node 24.20.0, PostgreSQL 18.4 e Restic 0.19.1.

## Resultado

- Quatro testes do executor aprovados: transportes Docker locais, identificação
  dos recursos, limite de diretório e lista de arquivos permitidos na limpeza.
- Ensaio real com 14 etapas aprovado: clusters isolados, fixtures, repositório
  criptografado, dump completo e roles, verificações positivas/negativas e limpeza.
- Dados de todas as tabelas de autenticação da migração atual e de fixtures
  adicionais coincidiram após restauração. Comparação incluiu proprietários,
  ACLs, default privileges, sequences, constraints e grants entre roles.
- Leituras autorizadas e recusa de escrita foram exercitadas no banco restaurado;
  FK e privilégios padrão de uma nova tabela também foram conferidos.
- Dump interrompido não criou snapshot; senha errada e seletor `latest` não
  criaram banco; restauração sobre destino ocupado foi recusada sem mudar seu
  estado; alteração deliberada de um pack foi detectada pela leitura de integridade.
- Nenhum hash de senha de role foi transferido; o administrador do destino
  continuou acessível com sua credencial independente.
- Containers, rede, volume e arquivos privados das execuções foram removidos.
  Imagens de teste permanecem apenas como cache de build, sem dados ou segredos.
- ESLint aprovado; comandos e procedimento em [RECOVERY-DRILL.md](RECOVERY-DRILL.md).

## Tempos observados

Na execução local concluída às 20:07:05 UTC, o fluxo completo levou 58,8 s,
incluindo preparação e limpeza. Backup: 3,1 s; restauração e conferência: 6,5 s.
As medidas incluem os containers temporários dos comandos. O dataset é pequeno
e fictício; os números não estimam o tempo de recuperação de produção.

O executor gera relatório JSON sanitizado por execução e não registra linhas do
banco ou senhas. A CI executa o mesmo ensaio em Linux no job `recovery-check`;
o resultado associado ao commit é registrado na PR.

## Limites

Não houve leitura nem backup do banco da aplicação, alteração do login Google,
acesso à VPS ou criação de credenciais externas. A amostra valida PostgreSQL e
Restic localmente; não valida R2, agendamento, alertas, retenção, anexos,
OmniRoute, ARM64 ou os objetivos RPO/RTO. M0 permanece em andamento.
