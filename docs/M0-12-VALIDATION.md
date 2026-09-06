# STK-M0-12 — Configuração de produção e HTTPS

Data: 2026-09-06. Base: `183bd9bf7608c3c5d5bde41741a77bbd2492bbe3`.
Implementação e verificação pelo Codex, conforme a instrução do proprietário.

## Evidências locais

- Tipos, lint e 60 testes unitários aprovados. Os novos casos recusam runtime
  incompleto, autenticação desabilitada em produção, origem insegura, segredos
  diretos/ambíguos, arquivo ausente ou inválido e URL de banco alternativa.
- OpenAPI regenerado e sincronizado; `stage` passa a aceitar também
  `production-setup`. A interface apresenta o ambiente correspondente sem
  habilitar funcionalidades de produto.
- 24 integrações PostgreSQL/Google simulado/pg-boss aprovadas, preservando os
  dados reais da aplicação local.
- Ensaio Linux AMD64 em Docker Desktop: quatro imagens construídas, segredos
  aleatórios próprios, banco novo e portas efêmeras somente em loopback.
- Checker de configuração aceita a forma de imagens por digest e recusa IDs
  locais como substitutos de imagens publicadas. Casos alterados recusam
  exposição da API, portas de ensaio fora de loopback, segredo direto,
  autenticação desabilitada e rede de banco não interna.
- Migrador recusa execução de produção sem confirmação explícita; execução
  confirmada e repetição aprovadas no banco descartável.
- Quatro serviços saudáveis, sem segredos em variáveis de ambiente e sem portas
  publicadas de PostgreSQL/API/worker. Serviços Node e web sem root e com
  filesystem somente leitura.
- Banco acessado por `stakeframe_app`, sem superusuário, criação de bancos ou
  papéis, replicação ou bypass de RLS.
- HTTP redireciona por 308 para a origem HTTPS canônica, sem a porta interna.
  Cliente HTTPS rejeita a CA desconhecida e aceita somente a CA fornecida para
  o teste. Healthcheck e web respondem; acesso anônimo retorna 401, origem
  indevida retorna 403, login inicia OAuth com callback HTTPS e cookies
  Secure/HttpOnly. Nenhum login ou token Google real foi usado no ensaio.
- Após reiniciar PostgreSQL, API, worker e Caddy, a readiness, o dado fictício
  e a CA persistem. O runner consulta novamente a porta efêmera do Docker,
  que pode mudar no reinício.
- Limpeza confere labels e caminho antes de remover recursos e arquivos
  próprios. Relatório sanitizado em `.cache/deployment-reports`; a evidência
  remota vinculada ao head ficará na PR.

## CI e limites

O ensaio foi acrescentado aos jobs AMD64 e ARM64 nativo, junto com os 100
testes da aplicação por arquitetura (60 unitários, 24 integrações, 16 de
navegador). O resultado efetivo por head é registrado na PR antes da decisão
de integração. Recuperação e simulação de rede continuam como jobs separados.

Não houve publicação de imagens, modificação da VPS, DNS, certificados públicos,
conta Google de produção, migração ou implantação de produção. Não há schema
de produto novo. A CA de ensaio não é instalada no host. O ensaio não valida
R2, backup de produção, RPO/RTO ou operação na VPS.

Procedimento e limites em [PRODUCTION-CONFIGURATION.md](PRODUCTION-CONFIGURATION.md)
e [DEPLOYMENT.md](DEPLOYMENT.md). M0 permanece em andamento.
