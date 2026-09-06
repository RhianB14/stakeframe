# STK-M0-11 — Evidências de imagens de execução

Data: 2026-09-06. Base: `25dd9deb1995f69a9e4f6427bbbb0c7597852ffe`.
Escopo: artefatos locais de API, worker e migração, sem publicação ou VPS.

## Verificação local

- Instalação com lockfile congelado, tipos, lint e 39 testes unitários aprovados.
- OpenAPI válido e sincronizado com o documento versionado.
- 24 integrações aprovadas com PostgreSQL 18 e endpoints Google simulados,
  usando bancos/schemas de teste próprios. Dados da aplicação preservados.
- Três imagens construídas para Linux AMD64 com Node 24.20.0. O controle de
  versões aceitou 102 pacotes na API, 29 no worker e 19 no migrador, todos
  presentes na instalação de origem com lockfile congelado.
- Probes dos três targets aprovados em containers sem rede, filesystem
  somente leitura e usuário não root. APIs por injeção, importação do worker,
  resolução de dependências e arquivos SQL/journal do migrador conferidos.
- Inspeção recusa ferramentas de desenvolvimento, links quebrados/externos,
  arquitetura incorreta e ausência dos arquivos esperados. Durante o ajuste,
  a imagem intermediária foi corretamente recusada por conter esbuild e,
  depois, por um alias de workspace quebrado; ambas as causas foram corrigidas.
- Containers dos probes removidos após conferência de nome e label. Imagens
  de revisão e cache de build podem permanecer disponíveis localmente.

Tamanhos reportados por `docker image inspect` no mesmo Docker Desktop Linux
AMD64, em bytes (não somar camadas compartilhadas como consumo adicional):

| Imagem   |              Anterior |  STK-M0-11 | Redução aproximada |
| -------- | --------------------: | ---------: | -----------------: |
| API      |           138.185.815 | 89.245.462 |              35,4% |
| Worker   |           138.185.824 | 85.346.846 |              38,2% |
| Migrador | Usava a imagem da API | 82.971.265 |    Target separado |

As medidas variam por plataforma e representação do armazenamento Docker.
O comportamento da aplicação e as versões das bibliotecas são preservados;
o lockfile muda somente pelos dois peers opcionais removidos e checksum do hook.

## CI e limites

A CI repete build, inspeção das imagens, 79 testes da aplicação, migrações,
PostgreSQL/pg-boss/Google simulado e navegador desktop/mobile em AMD64 e
ARM64 nativo. O resultado vinculado ao head da PR é a evidência de conclusão
dessas execuções; os testes locais acima foram executados somente em AMD64.
Os jobs existentes de recuperação e simulação de rede continuam ativos.

Não houve publicação de imagem, release, deploy, mudança de rede ou migração
em produção. ARM64 em runner não comprova execução na VPS Oracle. DNS/HTTPS,
backups R2, segredos de produção e a pendência operacional da issue #11
permanecem fora desta tarefa. Procedimento em [RUNTIME-IMAGES.md](RUNTIME-IMAGES.md).
