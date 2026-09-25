# G0-01 — Schema e critérios de validação do corpus de bilhetes

> Contrato consolidado no parecer técnico do card `t_1e74685c` (gate G0-01) e
> transcrito para o repositório. Estado em 25/09/2026: **escopo ratificado por
> D025 — 2 casas (Bet365 e Superbet)** (ver "Ratificação D025"); armazenamento
> privado provisionado como estrutura em `data/corpus/private/` (fora de
> versionamento); a ingestão real dos bilhetes (>=20; >=10 por casa) usa os
> artefatos fornecidos pelo proprietário.

## Objetivo

Definir o contrato mínimo de captura e validação de um corpus privado de bilhetes para Bet365 e Superbet, separando evidência bruta, dados sanitizados e ground truth. Este contrato é vinculante tecnicamente para as tarefas dependentes do gate; ele não autoriza, por si só, coleta, chamadas de IA, ativação de importação automática, deploy ou acesso a banco.

## Contexto e evidências

- `packages/shared/src/imports.ts:53-76` define o contrato atual de extração: bookmaker, referência, data de realização como texto, moeda, stake, odds, retorno potencial, freebet, seleções e warnings. Ele permite `null` para campos não visíveis e não contém status de liquidação.
- `packages/shared/src/automatic.ts:4-33` define o envelope de avaliação privada: hash da imagem, layout esperado, expected e actual da extração.
- `scripts/validation/corpus-core.mjs:70-117` exige, para elegibilidade de layout, >=20 positivos, >=5 negativos, >=3 múltiplas, >=3 ausências e >=3 promocionais quando aplicável, zero erros essenciais e imagens únicas. Isso é distinto do mínimo de composição deste contrato.
- `docs/VALIDATION.md:55-108` exige que corpus, gabaritos e respostas reais permaneçam fora do Git; o avaliador é offline e uma política operacional depende de autorização explícita.
- G0-05 possui ground truth privado v3 válido e cobertura de 20 positivos + 5 negativos por Bet365/Superbet, mas a execução real foi interrompida por `AI_RATE_LIMITED` na 7ª chamada; 6 chamadas foram consumidas, nada foi gravado e a retomada excede o teto autorizado de chamadas. D025 limita o beta a Bet365/Superbet (ratificada em 25/09/2026 para o escopo deste corpus — ver "Ratificação D025").
- O provisionamento do armazenamento privado foi recusado por limitação de writable paths do perfil DevOps (card `t_89c05818`); a estrutura passou a ser provisionada em 25/09/2026 (ver "Armazenamento privado").

## Ratificação D025 (25/09/2026)

Decisão do proprietário registrada pelo orquestrador em 25/09/2026: **D025
ratificado** — o corpus do gate G0-01 passa a ter **duas casas: Bet365 e
Superbet**; **Novibet sai do escopo do corpus**.

Efeitos neste contrato:

- `scope.bookmakers = ['bet365','superbet']` e `bookmaker` restrito a essas duas casas;
- critério de composição: **>=20 tickets válidos no total, >=10 por casa**
  (antes: >=30 no total, >=10 por cada uma das três casas);
- Novibet removido de requisitos, listas e exemplos deste documento.

A pendência 1 da seção "Pendências" fica resolvida por esta ratificação. A
ratificação é do corpus G0-01; ela não altera sozinha outros gates (a
homologação de importação segue `docs/VALIDATION.md`).

## Dois contratos que não podem ser confundidos

- **Contrato de corpus G0-01** (proposto abaixo): rastreabilidade, estado e privacidade para capturar, anonimizar e validar a amostra.
- **Contrato de extração do produto**: o `ticketExtractionSchema` atual, que representa somente fatos legíveis e permite `null` para evidência ausente.
- Não se deve alterar o schema de runtime para acomodar metadados de corpus.

## Schema proposto (`schemaVersion: 1`)

Contrato privado, mantido exclusivamente no diretório privado provisionado pelo humano:

```text
CorpusManifest
  schemaVersion: 1
  corpusId: string UUID
  scope: { bookmakers: ['bet365','superbet'], purpose: 'g0-01' }
  tickets: CorpusTicket[]

CorpusTicket
  corpusTicketId: string (^[a-z0-9][a-z0-9-]{2,63}$; ex.: bet365-001)
  bookmaker: 'bet365' | 'superbet'
  source: {
    artifactKind: 'screenshot' | 'export' | 'url'
    rawRelativePath: string
    rawSha256: string SHA-256
    capturedAt: ISO-8601 com offset
    sourceUrl: null | '[REDACTED]'  // URL não é permitida no dataset sanitizado
  }
  sanitized: {
    relativePath: string
    sha256: string SHA-256
    piiReview: 'pass'
    reviewedAt: ISO-8601 com offset
  }
  ticket: {
    internalId: corpusTicketId
    placedAt: ISO-8601 com offset
    event: { league: string, homeTeam: string, awayTeam: string, startsAt: ISO-8601 com offset }
    selections: [{ market: string, selection: string, oddsDecimal: decimal string >=1.01 <=1000 }]
    stake: { currency: 'BRL', amount: decimal string >0 }
    potentialReturn: { currency: 'BRL', amount: decimal string >=0 }
    status: 'pending' | 'won' | 'lost'
  }
  provenance: { transcribedBy: opaque operator ID, reviewedBy: opaque operator ID, reviewedAt: ISO-8601 com offset }
```

### Regras obrigatórias

- Todos os campos acima devem existir e ser parseáveis; nenhum `null` é aceito no corpus de composição G0-01. Caso um valor não seja visível, o artefato não entra nesta amostra e deve ser recapturado/exportado.
- `internalId` é um identificador do corpus, não ID de conta, código de aposta de casa, telefone ou nome.
- `rawRelativePath` e `sanitized.relativePath` devem ser paths relativos, sem `..`, na convenção `raw/<bookmaker>/<NNN>.<ext>` e `sanitized/<bookmaker>/<NNN>.<ext>`; `NNN` de 001 a 010 no mínimo.
- Não inferir data do evento, status, moeda, stake, odds, retorno ou seleção. A fonte deve evidenciar o dado; transcrição de export confiável é permitida se vinculada ao artefato.
- O status é de liquidação observada no artefato/export; pré-apostas não liquidadas são `pending`, não `lost`.
- `potentialReturn` é o retorno potencial exibido, não lucro líquido calculado. Não derivar o valor.
- Cada hash bruto deve ser único no corpus; duplicatas, mesmo com outro nome, são rejeitadas.

### Privacidade e sanitização

- PII direta: nome/username do apostador, e-mail, telefone, endereço, CPF/documento, identificadores de conta, QR/código de pagamento, cartão, dados bancários, IDs de transação e tokens/sessão.
- Identificadores indiretos/persistentes: URL privada, código de aposta/referência externa, QR code, barcode, device ID, geolocalização, avatar e metadados EXIF.
- `raw/` é somente leitura após hash; não pode ser commitado, enviado ao GitHub, anexado ao Kanban, logado ou usado em testes públicos. `sanitized/` deve aplicar redaction/blur irreversível, remover metadados e ser revisado visualmente. Mesmo sanitizado, permanece privado por padrão.
- Dados de domínio (casa, evento, liga, mercados, odds, stake, retorno, status e datas) só podem ser preservados se não incluírem PII. Referência externa de aposta não é dado de domínio necessário e deve ser removida/substituída por `corpusTicketId`.

### Checklist de captura (por bilhete)

1. Confirmar a casa na evidência e atribuir `bookmaker` permitido.
2. Capturar o artefato íntegro; calcular o SHA-256; registrar horário e origem sem expor URL/credenciais.
3. Conferir visualmente todos os campos obrigatórios, incluindo liga/times, início do evento, ao menos uma seleção, odds, stake, retorno potencial e status.
4. Atribuir ID `casa-NNN`, sem reutilizar ID ou hash.
5. Remover metadados e redigir PII no derivado sanitizado; revisar visualmente blur/redactions e registrar o hash do derivado.
6. Fazer revisão por segunda pessoa/operador e registrar apenas IDs opacos no manifesto.
7. Rejeitar e recapturar qualquer item com campo obrigatório ilegível, inconsistente, duplicado, PII residual ou artefato sem hash.

### Critério de aceite de COMPOSIÇÃO G0-01

- > =20 tickets válidos no manifesto; >=10 de cada casa (Bet365 e Superbet);
- 100% dos tickets passam schema, hashes e regra de unicidade;
- 100% têm raw e sanitized existentes no storage privado, com PII review `pass`;
- nenhuma evidência ou manifest privado no Git, PR, Kanban ou logs;
- relatório posterior deve separar PASS/FAIL por item sem expor valores/PII.

Este aceite de composição não aprova layout, IA ou automação. Para tal, aplicar adicionalmente `docs/VALIDATION.md` por layout/casa e manter a importação automática desativada até autorização humana expressa.

## Armazenamento privado

A estrutura fica em `data/corpus/private/` (fora de versionamento):

- `raw/<casa>/<NNN>.<ext>` — evidência bruta; somente leitura após o hash.
- `sanitized/<casa>/<NNN>.<ext>` — derivado com redaction/blur irreversível.
- `manifest.json` — manifesto real (a partir de `manifest.template.json`).
- `README.md` — instruções operacionais do diretório.

O `.gitignore` do repositório e o do próprio diretório cobrem `raw/`, `sanitized/` e `manifest.json`; apenas o README, o template e o próprio `.gitignore` são versionados. Em sistemas POSIX, usar permissões `0700` (diretórios) e `0600` (arquivos); no Windows, manter ACL restrita ao usuário.

Validação local (somente leitura, sem rede):

```text
node scripts/validation/ingest-corpus.mjs data/corpus/private --init   # cria a árvore de diretórios por casa
node scripts/validation/ingest-corpus.mjs data/corpus/private          # valida o manifesto contra este contrato
```

O validador confere schema, unicidade de IDs/hashes, convenção de paths, presença dos artefatos, hashes dos arquivos e contagens por casa; nunca grava, nunca imprime conteúdo de bilhete e nunca acessa a rede.

## Rollback

Não há mudança de dados por este contrato. Se uma futura captura falhar, remover somente o derivado sanitizado e o registro do manifesto em staging; preservar o bruto privado imutável para auditoria, a menos que o proprietário determine descarte seguro. Nunca tentar "corrigir" o artefato bruto, sobrescrever hash ou reutilizar resultado de OCR como ground truth.

## Pendências (decisão humana)

1. **Resolvida em 25/09/2026** — D025 ratificado: o corpus usa duas casas (Bet365 e Superbet) e Novibet sai do escopo (ver "Ratificação D025").
2. Provisionamento do armazenamento privado: resolvido como estrutura em 25/09/2026 (`data/corpus/private/`); a ingestão real aguarda o fornecimento dos artefatos pelo proprietário.
3. Decisão humana sobre retomar chamadas pagas após `AI_RATE_LIMITED`: autorizar ou não teto revisado (mínimo contabilizado: 56 chamadas para reiniciar 2x25 após 6 consumidas), com throttling. Este contrato não autoriza isso.
4. Os critérios do gate pedem 10 por casa, mas a validação operacional existente pede >=20 positivos por layout; manter os dois gates explicitamente separados.
5. Antes de uma validação futura, confirmar que os casos com datas/eventos/status não visíveis sejam excluídos do corpus de composição ou providos por export rastreável; não preencher por inferência.

## Estado da execução (25/09/2026)

- Schema e critérios registrados neste documento.
- Estrutura de armazenamento provisionada (`data/corpus/private/` com `.gitignore` de cobertura dupla).
- Validador de ingestão `scripts/validation/ingest-corpus.mjs` disponível (somente leitura).
- Ingestão real: artefatos fornecidos pelo proprietário em 25/09/2026 (screenshots de Bet365 e Superbet); a captura bruta roda no armazenamento privado local, sem dados de bilhete no repositório. Nenhum bilhete foi inventado ou sintetizado como corpus; as fixtures de teste existentes em `scripts/validation/corpus-fixture.mjs` não são corpus.
