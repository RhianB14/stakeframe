# STK-M0-16 — Gemini direto e preservação do OmniRoute

Autoria e verificação direta por Codex, conforme diretriz vigente do
proprietário. Não constitui revisão independente do GitHub.

## Decisão e autorização

O proprietário pediu backup do OmniRoute local e comparação com suas APIs
existentes antes de instalar outro serviço na VPS. Após a apresentação dos
modelos e limites observados, aprovou Gemini direto e a continuidade. A D017
substitui a exigência de OmniRoute na VPS, mantendo a operação independente
do computador pessoal e o orçamento gratuito escolhido.

## Backup local executado

- SQLite copiado pela API online de backup com conexão de leitura; nenhuma
  parada do OmniRoute ou cópia de seu WAL/SHM em uso.
- Demais arquivos do diretório de dados, ambientes privados, bundle Git do
  HEAD local e três arquivos de código modificados preservados fora do Git.
  Dependências recompiláveis, perfis de navegador e outros aplicativos não
  fazem parte desse backup. Arquivos auxiliares não representam um snapshot
  global; nenhum mudou de tamanho/data durante sua cópia individual.
- Restic 0.19.1 portátil, arquivo oficial Windows verificado contra SHA-256
  publicado. Repositório local criptografado e senha aleatória em pasta
  separada, com ACL limitada ao proprietário e SYSTEM.
- Snapshot `57195676a0e3ee04a6234aabcac5cf36bc61a4354e0d5206fe6276ce4ff0cc78`:
  10.104 arquivos incluindo manifesto; 2.658.185.842 bytes lógicos e
  700.706.838 bytes de dados empacotados adicionados.
- `restic check --read-data`: 43 packs conferidos, sem erros. Restauração em
  outro diretório: todos os 10.103 hashes de conteúdo conferidos; banco íntegro,
  bundle Git válido e material criptográfico suficiente para decifrar todos
  os 35 campos de credenciais existentes nas 27 conexões.
- Verificação concluída em `2026-09-07T00:17:12.612Z` (06/09 à noite em São
  Paulo). Nenhuma instância restaurada foi iniciada nem provedor testado.

O backup ainda está no mesmo computador, sem cópia externa R2/VPS. As duas
cópias temporárias sem criptografia externa permanecem sob ACL privada:
a revisão automática bloqueou a exclusão com motivo genérico de política.
Essa limpeza não está concluída. A instalação original permanece intacta.
Guia, senha e relatórios detalhados ficam fora do repositório público.

## Integração Gemini preparada

- Cotas e recursos comparados em [AI-MODEL-SELECTION.md](AI-MODEL-SELECTION.md).
- Credencial existente preservada em pasta privada para o ensaio, sem criar
  chave, modificar permissões ou ativar faturamento. O projeto permanece free.
- Ferramenta limitada e seis testes offline em [AI-PROBE.md](AI-PROBE.md).
- Catálogo autenticado da API confirmou `generateContent` para os três modelos.
- `gemini-3.1-flash-lite`: prova real aprovada em `2026-09-07T00:44:58.674Z`,
  latência de 6.531 ms; 8/8 campos do exemplo conferidos, incluindo data ausente
  e valores decimais. Contagem do provedor: 1.162 tokens de entrada, 81 de saída,
  105 de raciocínio, 1.348 no total. É o principal inicial para avaliação privada.
- `gemini-3.5-flash-lite` e `gemini-3.8-flash`: HTTP 503 `UNAVAILABLE`; nenhum
  resultado de extração aprovado. A primeira tentativa do 3.5 foi registrada
  pelo helper ainda sem status HTTP; após ajuste para enum canônico `LOW` e
  diagnóstico limitado, houve uma nova execução deliberada com registro
  separado. Não atribuir a falha inicial ao parâmetro sem evidência.
- Total desta etapa: quatro requisições de geração deliberadas (três sem
  resposta de extração e uma aprovada), além de leitura autenticada do catálogo.
  Não houve repetição automática, chamada a provedor pago nem teste com imagem real.

## Verificações locais

- Seis testes offline aprovados, incluindo 429/503, recusa de imagem/modelo
  diferentes, erros sem segredo e reprovação de campos incorretos.
- Reexecução do ensaio já concluído recusada com `AI_ALREADY_ATTEMPTED`, antes
  de outra chamada. Lint, formatação dos arquivos suportados e `git diff --check`
  aprovados. `.env.example` é texto de placeholders e não tem parser Prettier.
- Nenhuma dependência adicionada. A CI repete os testes offline e a suíte
  existente em AMD64 e ARM64; resultados de CI serão registrados na PR.

## Limites

Sem migração, deploy ou segredos instalados na VPS. Sem chamadas ao Go, compras,
imagens reais enviadas ao Google, registro de apostas ou alterações de schema.
Precisão nos bilhetes privados e integração contínua Gemini/Telegram/R2 ainda
pendem de etapas próprias. M0 permanece em andamento.
