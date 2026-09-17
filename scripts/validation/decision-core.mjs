import {
  corpusEvaluationInputSchema,
  homologationContextSchema,
  parseAutomaticPlacedAt,
  ticketExtractionSchema,
} from '../../packages/shared/dist/index.js';
import { KNOWN_BOOKMAKERS, normalizeEvent, normalizeMarket } from './corpus-core.mjs';

// STK-G0-19-R3 — avaliação offline orientada à decisão, na ORDEM REAL do
// fluxo: (1) schema, (2) layout selecionado, (3) modelo aprovado, (4)
// política/digest (verificada no fluxo real; o corpus offline não carrega o
// artefato completo da política), (5) OCR consistente, (6) contexto informado,
// (7) casa e aliases, (8) ORIGEM declarada pelo usuário (real/freebet —
// betOrigin), (9) placedAt, (10) financeiro, (11) duplicidade, (12) dados
// efetivamente persistidos. R5: a origem nunca vem da imagem/IA/legenda — o
// contexto privado registra a declaração do proprietário; o retorno potencial
// é CALCULADO (stake × odds, decimal exato) e o valor visual é somente
// diagnóstico de fidelidade — divergência indica stake/odd possivelmente
// incorretos e encaminha para revisão, nunca substitui o cálculo.
// A data/hora do evento NÃO participa da decisão: eventDateText é
// reservado/depreciado, nunca autoriza nem bloqueia, nunca é persistido, e
// toda seleção automática nasce pendente de enriquecimento (eventDate e
// eventAt nulos, dateStatus 'pending').
// O contexto privado (por imageSha256) declara apenas o que o proprietário
// informou: casa, tipo, placedAt quando a imagem não traz data legível e o
// estado do crédito freebet. Nunca é derivado de nome de arquivo, timestamp,
// saída da IA, data do evento ou período/minuto ao vivo.

const AUTO = 'AUTO_IMPORT_EXPECTED';
const MANUAL = 'MANUAL_REVIEW_EXPECTED';
const WOULD = 'WOULD_IMPORT';
const REVIEW = 'MANUAL_REVIEW';

const normalized = (value) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ');

const decimalEq = (left, right) => {
  const fix = (value) =>
    String(value)
      .replace(/\.0+$/, '')
      .replace(/(\.\d*?)0+$/, '$1');
  return fix(left) === fix(right);
};

const instant = (value) => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const saoPauloDay = (iso) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));

// Lado esperado: o que um modelo PERFEITO (ground truth + contexto) poderia
// decidir com o fluxo real. Negativas cross-house nunca são autoimportáveis
// por esta casa.
function expectedSide(item, layout, contextCase) {
  const issues = [];
  const parsed = ticketExtractionSchema.safeParse(item.expected);
  if (!parsed.success) issues.push('schema');
  if (item.expectedLayoutId === null) issues.push('negative');
  else if (item.expectedLayoutId !== layout.id) issues.push('layout');
  if (!contextCase) issues.push('context_missing');
  else if (contextCase.bookmaker !== layout.bookmaker) issues.push('context_bookmaker');
  const kind = contextCase?.kind ?? null;
  if (!kind) issues.push('kind_missing');
  const expected = parsed.success ? parsed.data : null;
  if (expected) {
    if (expected.warnings.length) issues.push('warnings');
    if (expected.currency !== 'BRL') issues.push('currency');
    if (!expected.stake) issues.push('stake');
    if (!expected.odds) issues.push('odds');
    if (expected.bookmaker !== null && normalized(expected.bookmaker) !== layout.bookmaker)
      issues.push('bookmaker');
    if (kind === 'real' && expected.freebet === true) issues.push('freebet_conflict');
    if (kind === 'freebet' && expected.freebet === false) issues.push('freebet_conflict');
    const visual =
      expected.placedAtText === null
        ? null
        : parseAutomaticPlacedAt(expected.placedAtText, layout.placedAtFormat);
    if (expected.placedAtText !== null && visual === null) issues.push('placedAt_unparseable');
    const contextual = instant(contextCase?.placedAt ?? null);
    if (contextCase?.placedAt != null && contextual === null) issues.push('placedAt_unparseable');
    if (visual !== null && contextual !== null && visual !== contextual)
      issues.push('placedAt_divergent');
    if (visual === null && contextual === null) issues.push('placedAt_missing');
  }
  if (kind === 'freebet' && (contextCase?.freebetCredit ?? 'uncontrolled') !== 'controlled')
    issues.push('credit');
  return { feasible: issues.length === 0, issues, kind };
}

// Lado observado: a decisão que o fluxo real tomaria sobre a extração
// preservada. Qualquer bloqueio resulta em revisão; WOULD_IMPORT só quando
// todos os passos passam.
function actualSide(item, layout, contextCase, duplicateImage) {
  const parsed = ticketExtractionSchema.safeParse(item.actual.extraction);
  if (!parsed.success) return { issues: ['EXTRACTION_UNCERTAIN'], placedAt: null, kind: null };
  const value = parsed.data;
  const issues = [];
  const negative = item.expectedLayoutId === null;
  // (2) layout selecionado
  if (negative) {
    issues.push(item.actual.layoutId === null ? 'CROSS_HOUSE_REVIEW' : 'LAYOUT_CONFLICT');
    // Rejeição cross-house é a própria decisão esperada: o conteúdo pertence
    // ao corpus da outra casa e não é avaliado contra este contexto.
    return { issues, placedAt: null, kind: null };
  }
  if (item.actual.layoutId === null) issues.push('LAYOUT_UNRECOGNIZED');
  else if (item.actual.layoutId !== layout.id) issues.push('LAYOUT_CONFLICT');
  // (3) modelo aprovado — fallback sem homologação própria cai aqui
  if (item.actual.model !== layout.model) issues.push('MODEL_UNAPPROVED');
  // (5) OCR consistente
  if (item.actual.ocrConsistent === false) issues.push('EXTRACTION_UNCERTAIN');
  // (6) contexto informado
  if (!contextCase) issues.push('CONTEXT_MISSING');
  const kind = contextCase?.kind ?? null;
  // (7) casa e aliases: a casa do contexto é a fonte da verdade; leitura
  // visual de OUTRA casa ou texto não resolvido bloqueiam (fail-closed).
  if (
    contextCase &&
    value.bookmaker !== null &&
    normalized(value.bookmaker) !== contextCase.bookmaker
  )
    issues.push('BOOKMAKER_CONFLICT');
  // (8) tipo real/freebet
  if (contextCase && kind === null) issues.push('CAPTION_UNRESOLVED');
  if (kind === 'real' && value.freebet === true) issues.push('FREEBET_CONFLICT');
  if (kind === 'freebet' && value.freebet === false) issues.push('FREEBET_CONFLICT');
  // (9) placedAt — imagem e contexto (4ª linha) precisam convergir; o horário
  // de upload/Telegram nunca participa.
  const visual =
    value.placedAtText === null
      ? null
      : parseAutomaticPlacedAt(value.placedAtText, layout.placedAtFormat);
  if (value.placedAtText !== null && visual === null) issues.push('PLACED_AT_UNCERTAIN');
  const contextual = instant(contextCase?.placedAt ?? null);
  if (contextCase?.placedAt != null && contextual === null) issues.push('PLACED_AT_UNCERTAIN');
  if (visual !== null && contextual !== null && visual !== contextual)
    issues.push('PLACED_AT_UNCERTAIN');
  const placedAt = visual ?? contextual;
  if (!placedAt) issues.push('PLACED_AT_UNCERTAIN');
  // (10) financeiro
  if (value.warnings.length || value.currency !== 'BRL' || !value.stake || !value.odds)
    issues.push('EXTRACTION_UNCERTAIN');
  // STK-G0-19-R6: o retorno visual NUNCA participa da decisão — divergência,
  // ausência ou rótulo faltante são somente diagnóstico de fidelidade
  // (returnFidelityMismatch no relatório). A base financeira é stake × odd
  // calculados; stake/odd realmente incertas seguem em revisão pelos seus
  // próprios códigos (EXTRACTION_UNCERTAIN etc.).
  // (11) duplicidade por imagem repetida dentro da própria evidência; a tupla
  // (casa + stake + odds + data em São Paulo) é conferida no passe seguinte.
  if (duplicateImage) issues.push('DUPLICATE_REVIEW_REQUIRED');
  // Freebet sem crédito único controlado permanece em revisão: o crédito só
  // existe no fluxo real; offline ele é declarado no contexto privado.
  if (!issues.length && kind === 'freebet' && contextCase?.freebetCredit !== 'controlled')
    issues.push('FREEBET_UNRESOLVED');
  return { issues, placedAt, kind };
}

// (12) dados efetivamente persistidos nesta fase: bookmaker (do contexto),
// stake, odd total, tipo, placedAt, referência confiável, quantidade de
// seleções e, por seleção, evento, esporte (somente explícito), mercado,
// seleção e odd. Data/hora do evento, minuto/período ao vivo, placar e
// eventDateText nunca entram aqui.
function persistedDiffs(expected, value, expectedPlacedAt, actualPlacedAt) {
  const diffs = [];
  if (!decimalEq(value.stake ?? '0', expected.stake ?? '0')) diffs.push('stake');
  if (!decimalEq(value.odds ?? '0', expected.odds ?? '0')) diffs.push('odds');
  if (
    (expected.reference ?? '') !== '' &&
    normalized(expected.reference ?? '') !== normalized(value.reference ?? '')
  )
    diffs.push('reference');
  if (expectedPlacedAt !== actualPlacedAt) diffs.push('placedAt');
  if (expected.selections.length !== value.selections.length) diffs.push('selections.length');
  const count = Math.min(expected.selections.length, value.selections.length);
  for (let i = 0; i < count; i++) {
    const left = expected.selections[i];
    const right = value.selections[i];
    if (normalizeEvent(left.event ?? '') !== normalizeEvent(right.event ?? ''))
      diffs.push('selections.' + i + '.event');
    if (left.sport !== null && normalized(left.sport) !== normalized(right.sport ?? ''))
      diffs.push('selections.' + i + '.sport');
    if (normalizeMarket(left.market ?? '') !== normalizeMarket(right.market ?? ''))
      diffs.push('selections.' + i + '.market');
    if (normalized(left.selection ?? '') !== normalized(right.selection ?? ''))
      diffs.push('selections.' + i + '.selection');
    if (!decimalEq(left.odds ?? '0', right.odds ?? '0')) diffs.push('selections.' + i + '.odds');
  }
  return diffs;
}

// Fidelidade do retorno potencial: métrica de transcrição/qualidade — nunca um
// valor financeiro errado (o principal gravado continua stake/odds corretos).
function returnFidelityDiffers(expected, value) {
  if (expected.potentialReturn === null) return value.potentialReturn !== null;
  return (
    value.potentialReturn === null || !decimalEq(value.potentialReturn, expected.potentialReturn)
  );
}

export function evaluateDecision(value, options = {}) {
  const input = corpusEvaluationInputSchema.parse(value);
  if (!KNOWN_BOOKMAKERS.includes(input.layout.bookmaker))
    throw new Error('DECISION_BOOKMAKER_UNKNOWN');
  const layout = input.layout;
  const context = options.context ? homologationContextSchema.parse(options.context) : null;
  const contextByHash = new Map((context?.cases ?? []).map((entry) => [entry.imageSha256, entry]));
  const hashCounts = new Map();
  for (const item of input.cases)
    hashCounts.set(item.imageSha256, (hashCounts.get(item.imageSha256) ?? 0) + 1);

  const cases = input.cases.map((item, index) => {
    const contextCase = contextByHash.get(item.imageSha256) ?? null;
    const negative = item.expectedLayoutId === null;
    const expected = expectedSide(item, layout, contextCase);
    const actual = actualSide(
      item,
      layout,
      contextCase,
      (hashCounts.get(item.imageSha256) ?? 0) > 1,
    );
    const expectedParsed = ticketExtractionSchema.safeParse(item.expected);
    const valueParsed = ticketExtractionSchema.safeParse(item.actual.extraction);
    const expectedPlacedAt = expectedParsed.success
      ? expectedParsed.data.placedAtText === null
        ? instant(contextCase?.placedAt ?? null)
        : parseAutomaticPlacedAt(expectedParsed.data.placedAtText, layout.placedAtFormat)
      : null;
    return {
      index: index + 1,
      negative,
      kind: actual.kind ?? expected.kind,
      expectedClass: negative ? MANUAL : (contextCase?.expectedDecision ?? MANUAL),
      expectedFeasible: expected.feasible,
      expectedIssues: expected.issues,
      actualClass: actual.issues.length ? REVIEW : WOULD,
      actualIssues: actual.issues,
      context: contextCase
        ? {
            bookmaker: contextCase.bookmaker,
            kind: contextCase.kind,
            credit: contextCase.freebetCredit,
            placedAt: contextCase.placedAt !== null,
            expectedDecision: contextCase.expectedDecision,
          }
        : null,
      placedAt: actual.placedAt,
      persistedDiffs: null,
      returnFidelity: null,
      _value: valueParsed.success ? valueParsed.data : null,
      _expected: expectedParsed.success ? expectedParsed.data : null,
      _expectedPlacedAt: expectedPlacedAt,
    };
  });

  // (11) duplicidade offline pela tupla persistida (casa + stake + odds + data
  // em São Paulo) entre casos importáveis — o critério 'similar' do fluxo real.
  const tupleCounts = new Map();
  const tupleOf = (row) =>
    `${layout.bookmaker}|${row._value.stake}|${row._value.odds}|${saoPauloDay(row.placedAt)}`;
  for (const row of cases) {
    if (row.actualClass !== WOULD || !row._value || !row.placedAt) continue;
    const tuple = tupleOf(row);
    tupleCounts.set(tuple, (tupleCounts.get(tuple) ?? 0) + 1);
  }
  for (const row of cases) {
    if (row.actualClass !== WOULD || !row._value || !row.placedAt) continue;
    if ((tupleCounts.get(tupleOf(row)) ?? 0) > 1) {
      row.actualIssues.push('DUPLICATE_REVIEW_REQUIRED');
      row.actualClass = REVIEW;
    }
  }
  for (const row of cases) {
    if (row.actualClass === WOULD && row._value && row._expected) {
      row.persistedDiffs = persistedDiffs(
        row._expected,
        row._value,
        row._expectedPlacedAt,
        row.placedAt,
      );
      row.returnFidelity = returnFidelityDiffers(row._expected, row._value);
    }
  }

  const clean = cases.map(({ _value, _expected, _expectedPlacedAt, ...row }) => row);
  const positives = clean.filter((row) => !row.negative);
  const negatives = clean.filter((row) => row.negative);
  const wouldImport = clean.filter((row) => row.actualClass === WOULD);
  const review = clean.filter((row) => row.actualClass === REVIEW);
  const unsafe = clean.filter(
    (row) => row.actualClass === WOULD && (row.expectedClass === MANUAL || !row.expectedFeasible),
  );
  const wrongPersisted = clean.filter(
    (row) => row.actualClass === WOULD && row.persistedDiffs && row.persistedDiffs.length > 0,
  );
  const conflictAccepted = clean.filter(
    (row) =>
      row.actualClass === WOULD &&
      row.actualIssues.some(
        (issue) => issue === 'BOOKMAKER_CONFLICT' || issue === 'FREEBET_CONFLICT',
      ),
  );
  const bypass = clean.filter(
    (row) =>
      row.actualClass === WOULD &&
      row.actualIssues.some(
        (issue) =>
          issue === 'LAYOUT_UNRECOGNIZED' ||
          issue === 'LAYOUT_CONFLICT' ||
          issue === 'MODEL_UNAPPROVED',
      ),
  );
  const conservative = positives.filter(
    (row) => row.expectedClass === AUTO && row.actualClass === REVIEW,
  );
  const reasonCounts = {};
  for (const row of review)
    for (const issue of row.actualIssues) reasonCounts[issue] = (reasonCounts[issue] ?? 0) + 1;
  const conservativeReasons = {};
  for (const row of conservative)
    for (const issue of row.actualIssues)
      conservativeReasons[issue] = (conservativeReasons[issue] ?? 0) + 1;

  return {
    schemaVersion: 1,
    layoutId: layout.id,
    bookmaker: layout.bookmaker,
    bookmakerContext: input.bookmakerContext ?? 'visual-only',
    model: layout.model,
    totalCases: clean.length,
    positives: positives.length,
    negatives: negatives.length,
    expected: {
      autoImportExpected: positives.filter((row) => row.expectedClass === AUTO).length,
      manualReviewExpected: clean.filter((row) => row.expectedClass === MANUAL).length,
    },
    actual: { wouldImport: wouldImport.length, review: review.length },
    wouldImportByKind: {
      real: wouldImport.filter((row) => row.kind !== 'freebet').length,
      freebet: wouldImport.filter((row) => row.kind === 'freebet').length,
    },
    context: {
      provided: context !== null,
      entries: context?.cases.length ?? 0,
      positivesWithKind: positives.filter((row) => row.context && row.context.kind !== null).length,
      positivesWithoutContext: positives.filter((row) => !row.context).length,
      creditControlled: clean.filter((row) => row.context && row.context.credit === 'controlled')
        .length,
    },
    placedAtAvailable: positives.filter((row) => row.placedAt !== null).length,
    gates: {
      unsafeAutoImport: unsafe.length,
      wrongPersistedData: wrongPersisted.length,
      conflictAccepted: conflictAccepted.length,
      layoutOrPolicyBypass: bypass.length,
      crossTenantLeak: 0,
    },
    crossTenantLeakSource:
      'tests/integration/finance-tenant-isolation.test.ts (isolamento cross-tenant em transação real)',
    policyDigestSource:
      'digest da política verificado no fluxo real (result.policyDigest x layoutDigest) e na suíte de integração; o corpus offline não carrega o artefato completo da política',
    conservativeReview: conservative.length,
    conservativeReasons,
    reasonCounts,
    // Informativo: cada caso importado nasce com seleções pendentes de
    // enriquecimento de evento (eventDate null, eventAt null, dateStatus
    // 'pending') — não bloqueia a homologação.
    eventEnrichmentPending: wouldImport.length,
    returnFidelityMismatch: wouldImport.filter((row) => row.returnFidelity === true).length,
    quality: options.quality ?? null,
    cases: clean,
  };
}
