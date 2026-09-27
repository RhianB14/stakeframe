import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// G0-01 — validação da ingestão do corpus privado de bilhetes (contrato em
// docs/corpus/G0-01-schema.md; escopo ratificado por D025 em 25/09/2026: duas
// casas — bet365 e superbet). Somente leitura: confere o manifesto contra o
// contrato, a presença dos artefatos e o SHA-256 dos arquivos; nunca grava,
// nunca imprime conteúdo de bilhete e nunca acessa a rede. `--init` cria
// apenas a árvore de diretórios vazios por casa. A ingestão real depende dos
// artefatos fornecidos pelo proprietário; este script não capta, não
// anonimiza e não inventa dados.
//
// D026-B (decisão do proprietário, 27/09/2026): os campos de evidência
// ausente listados em DEFERRED_NULLABLE_FIELDS podem ser explicitamente
// nulos/omitidos quando houver nota de transcrição para o campo
// (transcriptionNotes[].field + ILEGIVEL_RECAPTURAR); qualquer null/ausente
// SEM nota continua sendo erro, e todo campo presente segue estrito.
//
// Uso:
//   node scripts/validation/ingest-corpus.mjs <dir-privado> [--init] [--manifest <arquivo>]

export const KNOWN_BOOKMAKERS = ['bet365', 'superbet'];

const MIN_TOTAL = 20;
const MIN_PER_BOOKMAKER = 10;
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_OFFSET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const ARTIFACT_KINDS = ['screenshot', 'export', 'url'];
const TICKET_STATUSES = ['pending', 'won', 'lost'];
// D026-B: campos de evidência ausente que aceitam null/ausente COM nota.
export const DEFERRED_NULLABLE_FIELDS = new Set([
  'placedAt',
  'event',
  'event.league',
  'event.startsAt',
  'event.awayTeam',
  'status',
  'potentialReturn',
]);
// D026-B: campos do schema que podem receber nota-anotação quando presentes.
const ANNOTATABLE_FIELDS = new Set([
  'placedAt',
  'event',
  'event.league',
  'event.homeTeam',
  'event.awayTeam',
  'event.startsAt',
  'status',
  'potentialReturn',
  'stake',
]);
const SELECTION_NOTE_PATTERN = /^selections\[(\d{1,3})\]\.(market|selection|oddsDecimal)$/;
const SELECTION_GAP_PATTERN = /^selections\[(\d{1,3})\]\.selection$/;
const NOTE_REASON = 'ILEGIVEL_RECAPTURAR';
// D026-B v1.2: o formato canônico do field é SEM o prefixo `ticket.`; o
// prefixo legado é aceito e normalizado na leitura.
const canonicalNoteField = (field) => field.replace(/^ticket\./, '');
const HOUSE_ALTERNATION = KNOWN_BOOKMAKERS.join('|');
const RAW_PATH_PATTERN = new RegExp(`^raw/(${HOUSE_ALTERNATION})/\\d{3}\\.[a-z0-9]+$`);
const SANITIZED_PATH_PATTERN = new RegExp(`^sanitized/(${HOUSE_ALTERNATION})/\\d{3}\\.[a-z0-9]+$`);

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isIsoWithOffset = (value) => typeof value === 'string' && ISO_OFFSET_PATTERN.test(value);
const isSha256 = (value) => typeof value === 'string' && SHA256_PATTERN.test(value);
const isMissingValue = (value) => value === null || value === undefined;

function isAmount(value, { min, exclusive = false }) {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) return false;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return false;
  return exclusive ? parsed > min : parsed >= min;
}

const isOdds = (value) => isAmount(value, { min: 1.01 }) && Number(value) <= 1000;

const fileSha256 = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

function validateManifest(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) return { errors: ['manifesto não é um objeto'], tickets: [] };
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion deve ser 1');
  if (typeof manifest.corpusId !== 'string' || !UUID_PATTERN.test(manifest.corpusId))
    errors.push('corpusId deve ser um UUID');
  const scope = manifest.scope;
  if (!isPlainObject(scope)) errors.push('scope ausente');
  else {
    if (scope.purpose !== 'g0-01') errors.push('scope.purpose deve ser g0-01');
    if (!Array.isArray(scope.bookmakers) || scope.bookmakers.length === 0)
      errors.push('scope.bookmakers deve ser uma lista não vazia');
    else if (scope.bookmakers.some((house) => !KNOWN_BOOKMAKERS.includes(house)))
      errors.push('scope.bookmakers contém casa desconhecida');
  }
  if (!Array.isArray(manifest.tickets)) errors.push('tickets deve ser uma lista');
  return { errors, tickets: Array.isArray(manifest.tickets) ? manifest.tickets : [] };
}

function validateSelections(selections, where, errors, notes) {
  if (!Array.isArray(selections) || selections.length === 0) {
    errors.push(`${where} selections deve ser uma lista não vazia`);
    return;
  }
  selections.forEach((selection, index) => {
    const at = `${where} selections[${index}]`;
    if (!isPlainObject(selection)) {
      errors.push(`${at} não é objeto`);
      return;
    }
    if (!nonEmptyString(selection.market)) errors.push(`${at} market inválido`);
    if (isMissingValue(selection.selection)) {
      if (!notes.has(`selections[${index}].selection`))
        errors.push(`${at} selection ausente/nulo sem nota de transcrição (D026-B)`);
    } else if (!nonEmptyString(selection.selection)) {
      errors.push(`${at} selection inválido`);
    }
    if (!isOdds(selection.oddsDecimal))
      errors.push(`${at} oddsDecimal inválido (decimal entre 1.01 e 1000)`);
  });
}

// D026-B: valida a forma das notas de transcrição e devolve o conjunto de
// campos anotados (gap explícito aceito).
function collectTranscriptionNotes(ticket, where, errors) {
  const notes = new Set();
  const value = ticket.transcriptionNotes;
  if (isMissingValue(value)) return notes;
  if (!Array.isArray(value)) {
    errors.push(`${where} transcriptionNotes deve ser uma lista`);
    return notes;
  }
  value.forEach((note, index) => {
    const at = `${where} transcriptionNotes[${index}]`;
    if (!isPlainObject(note)) {
      errors.push(`${at} não é objeto`);
      return;
    }
    if (!nonEmptyString(note.field)) {
      errors.push(`${at} field inválido`);
      return;
    }
    const field = canonicalNoteField(note.field.trim());
    if (!ANNOTATABLE_FIELDS.has(field) && !SELECTION_NOTE_PATTERN.test(field)) {
      errors.push(`${at} field fora da lista D026-B: ${field}`);
      return;
    }
    if (note.reason !== NOTE_REASON) {
      errors.push(`${at} reason deve ser ${NOTE_REASON}`);
      return;
    }
    if (notes.has(field)) {
      errors.push(`${at} nota duplicada para ${field}`);
      return;
    }
    notes.add(field);
  });
  return notes;
}

// D026-B: valor atual do campo anotado, para classificar gap real × anotação.
function noteTargetValue(body, field) {
  if (field === 'placedAt') return body.placedAt;
  if (field === 'status') return body.status;
  if (field === 'potentialReturn') return body.potentialReturn;
  if (field === 'stake') return body.stake;
  if (field === 'event') return body.event;
  if (field.startsWith('event.')) {
    if (!isPlainObject(body.event)) return undefined;
    if (field === 'event.league') return body.event.league;
    if (field === 'event.homeTeam') return body.event.homeTeam;
    if (field === 'event.startsAt') return body.event.startsAt;
    if (field === 'event.awayTeam') return body.event.awayTeam;
    return undefined;
  }
  if (!Array.isArray(body.selections)) return undefined;
  const match = SELECTION_NOTE_PATTERN.exec(field);
  if (!match) return undefined;
  const selection = body.selections[Number(match[1])];
  if (!isPlainObject(selection)) return undefined;
  if (match[2] === 'market') return selection.market;
  if (match[2] === 'oddsDecimal') return selection.oddsDecimal;
  return selection.selection;
}

// Validação de estrutura do bilhete, sem tocar o disco. Não imprime nem
// registra valores de campos financeiros; apenas caminhos de campo.
function validateTicket(ticket, index, seen) {
  const errors = [];
  const where = `tickets[${index}]`;
  const push = (message) => errors.push(`${where} ${message}`);
  if (!isPlainObject(ticket)) {
    push('não é objeto');
    return { errors, gapNotes: new Set() };
  }
  const notes = collectTranscriptionNotes(ticket, where, errors);
  const gapNotes = new Set();
  const id = ticket.corpusTicketId;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) push('corpusTicketId inválido');
  else if (seen.ids.has(id)) push(`corpusTicketId duplicado: ${id}`);
  else seen.ids.add(id);
  if (!KNOWN_BOOKMAKERS.includes(ticket.bookmaker)) push('bookmaker desconhecido');
  const source = ticket.source;
  if (!isPlainObject(source)) push('source ausente');
  else {
    if (!ARTIFACT_KINDS.includes(source.artifactKind)) push('source.artifactKind inválido');
    if (!isSha256(source.rawSha256)) push('source.rawSha256 inválido');
    else if (seen.rawHashes.has(source.rawSha256)) push('source.rawSha256 duplicado');
    else seen.rawHashes.add(source.rawSha256);
    if (!isIsoWithOffset(source.capturedAt))
      push('source.capturedAt inválido (ISO-8601 com offset)');
    if (!(source.sourceUrl === null || source.sourceUrl === '[REDACTED]'))
      push('source.sourceUrl deve ser null ou [REDACTED]');
  }
  const sanitized = ticket.sanitized;
  if (!isPlainObject(sanitized)) push('sanitized ausente');
  else {
    if (!isSha256(sanitized.sha256)) push('sanitized.sha256 inválido');
    else if (seen.sanitizedHashes.has(sanitized.sha256)) push('sanitized.sha256 duplicado');
    else seen.sanitizedHashes.add(sanitized.sha256);
    if (sanitized.piiReview !== 'pass') push('sanitized.piiReview deve ser pass');
    if (!isIsoWithOffset(sanitized.reviewedAt))
      push('sanitized.reviewedAt inválido (ISO-8601 com offset)');
  }
  const body = ticket.ticket;
  if (!isPlainObject(body)) push('ticket ausente');
  else {
    if (body.internalId !== id) push('ticket.internalId deve igualar corpusTicketId');
    if (isMissingValue(body.placedAt)) {
      if (!notes.has('placedAt'))
        push('ticket.placedAt ausente/nulo sem nota de transcrição (D026-B)');
    } else if (!isIsoWithOffset(body.placedAt)) {
      push('ticket.placedAt inválido (ISO-8601 com offset)');
    }
    const event = body.event;
    if (isMissingValue(event)) {
      if (!notes.has('event')) push('ticket.event ausente/nulo sem nota de transcrição (D026-B)');
    } else if (!isPlainObject(event)) {
      push('ticket.event inválido');
    } else {
      if (isMissingValue(event.league)) {
        if (!notes.has('event.league'))
          push('ticket.event.league ausente/nulo sem nota de transcrição (D026-B)');
      } else if (!nonEmptyString(event.league)) {
        push('ticket.event.league inválido');
      }
      if (!nonEmptyString(event.homeTeam)) push('ticket.event.homeTeam inválido');
      if (isMissingValue(event.awayTeam)) {
        if (!notes.has('event.awayTeam'))
          push('ticket.event.awayTeam ausente/nulo sem nota de transcrição (D026-B)');
      } else if (!nonEmptyString(event.awayTeam)) {
        push('ticket.event.awayTeam inválido');
      }
      if (isMissingValue(event.startsAt)) {
        if (!notes.has('event.startsAt'))
          push('ticket.event.startsAt ausente/nulo sem nota de transcrição (D026-B)');
      } else if (!isIsoWithOffset(event.startsAt)) {
        push('ticket.event.startsAt inválido (ISO-8601 com offset)');
      }
    }
    validateSelections(body.selections, `${where} ticket`, errors, notes);
    const stake = body.stake;
    if (
      !isPlainObject(stake) ||
      stake.currency !== 'BRL' ||
      !isAmount(stake.amount, { min: 0, exclusive: true })
    )
      push('ticket.stake inválido (BRL, decimal > 0)');
    const potentialReturn = body.potentialReturn;
    if (isMissingValue(potentialReturn)) {
      if (!notes.has('potentialReturn'))
        push('ticket.potentialReturn ausente/nulo sem nota de transcrição (D026-B)');
    } else if (
      !isPlainObject(potentialReturn) ||
      potentialReturn.currency !== 'BRL' ||
      !isAmount(potentialReturn.amount, { min: 0 })
    ) {
      push('ticket.potentialReturn inválido (BRL, decimal >= 0)');
    }
    if (isMissingValue(body.status)) {
      if (!notes.has('status')) push('ticket.status ausente/nulo sem nota de transcrição (D026-B)');
    } else if (!TICKET_STATUSES.includes(body.status)) {
      push('ticket.status inválido');
    }
    // D026-B: nota em campo presente é anotação (permitida, não conta como
    // gap); nota em campo estrito ausente e índice inexistente são erro.
    for (const field of notes) {
      const match = SELECTION_NOTE_PATTERN.exec(field);
      if (
        match &&
        (!Array.isArray(body.selections) || Number(match[1]) >= body.selections.length)
      ) {
        push(`transcriptionNotes aponta seleção inexistente: ${field}`);
        continue;
      }
      if (!isMissingValue(noteTargetValue(body, field))) continue;
      if (DEFERRED_NULLABLE_FIELDS.has(field) || SELECTION_GAP_PATTERN.test(field)) {
        gapNotes.add(field);
      } else {
        push(`transcriptionNotes para campo estrito ausente: ${field}`);
      }
    }
  }
  const provenance = ticket.provenance;
  if (!isPlainObject(provenance)) push('provenance ausente');
  else {
    if (!nonEmptyString(provenance.transcribedBy)) push('provenance.transcribedBy inválido');
    if (!nonEmptyString(provenance.reviewedBy)) push('provenance.reviewedBy inválido');
    if (!isIsoWithOffset(provenance.reviewedAt))
      push('provenance.reviewedAt inválido (ISO-8601 com offset)');
  }
  return { errors, gapNotes };
}

// Confere convenção do caminho, contenção no diretório privado e existência do
// arquivo (regular, não symlink, não vazio). Devolve o caminho absoluto válido
// ou null, registrando o motivo em errors.
async function checkArtifactFile(root, value, pattern, house, label, errors) {
  if (typeof value !== 'string') {
    errors.push(`${label} deve ser string`);
    return null;
  }
  const match = pattern.exec(value);
  if (!match) {
    errors.push(`${label} fora da convenção <raw|sanitized>/<casa>/<NNN>.<ext>`);
    return null;
  }
  if (match[1] !== house) {
    errors.push(`${label} não corresponde à casa do bilhete`);
    return null;
  }
  const target = resolve(root, value);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    errors.push(`${label} fora do diretório privado`);
    return null;
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile() || info.size === 0) {
      errors.push(`${label} inválido no disco`);
      return null;
    }
    return target;
  } catch {
    errors.push(`${label} ausente no disco`);
    return null;
  }
}

async function initStorage(root) {
  for (const house of KNOWN_BOOKMAKERS) {
    await mkdir(join(root, 'raw', house), { recursive: true });
    await mkdir(join(root, 'sanitized', house), { recursive: true });
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        action: 'init',
        created: ['raw', 'sanitized'],
        bookmakers: KNOWN_BOOKMAKERS,
        hint: 'copie manifest.template.json para manifest.json e preencha após a captura',
      },
      null,
      2,
    ),
  );
}

async function checkStorage(root) {
  let info;
  try {
    info = await lstat(root);
  } catch {
    info = null;
  }
  if (!info || !info.isDirectory()) {
    console.log(JSON.stringify({ ok: false, failures: ['CORPUS_DIRECTORY_MISSING'] }));
    process.exitCode = 1;
    return;
  }
  return root;
}

async function main(argv) {
  let dirArg;
  let manifestArg;
  let doInit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--init') {
      doInit = true;
      continue;
    }
    if (arg === '--manifest') {
      manifestArg = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) continue;
    if (!dirArg) dirArg = arg;
  }
  if (!dirArg) {
    console.error(
      'uso: node scripts/validation/ingest-corpus.mjs <dir-privado> [--init] [--manifest <arquivo>]',
    );
    process.exitCode = 1;
    return;
  }
  const root = resolve(dirArg);
  if (doInit) {
    await initStorage(root);
    return;
  }
  if (!(await checkStorage(root))) return;
  const manifestPath = manifestArg ? resolve(manifestArg) : join(root, 'manifest.json');
  let bytes;
  try {
    const info = await lstat(manifestPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_MANIFEST_BYTES)
      throw new Error('invalid manifest file');
    bytes = await readFile(manifestPath);
  } catch {
    console.log(
      JSON.stringify({
        ok: false,
        status: 'SEM_MANIFESTO',
        failures: ['CORPUS_MANIFEST_MISSING'],
        hint: 'crie manifest.json a partir de manifest.template.json',
      }),
    );
    process.exitCode = 1;
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    console.log(
      JSON.stringify({ ok: false, status: 'INVALIDO', failures: ['CORPUS_MANIFEST_JSON_INVALID'] }),
    );
    process.exitCode = 1;
    return;
  }
  const checked = validateManifest(manifest);
  const errors = [...checked.errors];
  const tickets = checked.tickets;
  const seen = { ids: new Set(), rawHashes: new Set(), sanitizedHashes: new Set() };
  const gapFields = new Set();
  let gapCount = 0;
  let rawFound = 0;
  let sanitizedFound = 0;
  for (const [index, ticket] of tickets.entries()) {
    const checkedTicket = validateTicket(ticket, index, seen);
    const ticketErrors = checkedTicket.errors;
    gapCount += checkedTicket.gapNotes.size;
    for (const field of checkedTicket.gapNotes) gapFields.add(field);
    if (isPlainObject(ticket) && isPlainObject(ticket.source) && isPlainObject(ticket.sanitized)) {
      if (KNOWN_BOOKMAKERS.includes(ticket.bookmaker)) {
        const rawPath = await checkArtifactFile(
          root,
          ticket.source.rawRelativePath,
          RAW_PATH_PATTERN,
          ticket.bookmaker,
          `tickets[${index}] source.rawRelativePath`,
          ticketErrors,
        );
        if (rawPath) {
          if (isSha256(ticket.source.rawSha256)) {
            if ((await fileSha256(rawPath)) === ticket.source.rawSha256) rawFound += 1;
            else ticketErrors.push(`tickets[${index}] source.rawSha256 divergente do arquivo`);
          }
        }
        const sanitizedPath = await checkArtifactFile(
          root,
          ticket.sanitized.relativePath,
          SANITIZED_PATH_PATTERN,
          ticket.bookmaker,
          `tickets[${index}] sanitized.relativePath`,
          ticketErrors,
        );
        if (sanitizedPath) {
          if (isSha256(ticket.sanitized.sha256)) {
            if ((await fileSha256(sanitizedPath)) === ticket.sanitized.sha256) sanitizedFound += 1;
            else ticketErrors.push(`tickets[${index}] sanitized.sha256 divergente do arquivo`);
          }
        }
      }
    }
    errors.push(...ticketErrors);
  }
  const counts = Object.fromEntries(
    KNOWN_BOOKMAKERS.map((house) => [
      house,
      tickets.filter((ticket) => isPlainObject(ticket) && ticket.bookmaker === house).length,
    ]),
  );
  const missingPerBookmaker = Object.fromEntries(
    KNOWN_BOOKMAKERS.map((house) => [house, Math.max(0, MIN_PER_BOOKMAKER - counts[house])]),
  );
  const totalMissing = Math.max(0, MIN_TOTAL - tickets.length);
  const compositionReady =
    tickets.length >= MIN_TOTAL &&
    KNOWN_BOOKMAKERS.every((house) => counts[house] >= MIN_PER_BOOKMAKER);
  let status = 'PRONTO';
  if (errors.length) status = 'INVALIDO';
  else if (tickets.length === 0) status = 'VAZIO';
  else if (!compositionReady) status = 'INCOMPLETO';
  else if (gapCount > 0) status = 'PRONTO_COM_GAP';
  console.log(
    JSON.stringify({
      ok: errors.length === 0,
      status,
      total: tickets.length,
      counts,
      missingPerBookmaker,
      totalMissing,
      artifacts: { rawFound, sanitizedFound, expected: tickets.length },
      gaps: { notes: gapCount, fields: [...gapFields].sort() },
      errors,
    }),
  );
  if (errors.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2));
}
