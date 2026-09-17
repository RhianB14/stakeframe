import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTicketForEvidence, readAiConfig } from '../../apps/worker/dist/openrouter.js';
import {
  extractConfiguredOcr,
  readOcrProvidersConfig,
} from '../../apps/worker/dist/ocr-providers.js';
import {
  OPENROUTER_MODEL,
  OPENROUTER_MODELS,
  corpusEvaluationInputSchema,
  ticketExtractionSchema,
} from '../../packages/shared/dist/index.js';

// Private replay of the corpus against the real worker extraction path
// (apps/worker/src/openrouter.ts). One paid call per image, sequential and
// without automatic retries; per-image failures stay as sanitized errors and
// are never replaced by expected values. Writes corpus.json only inside the
// private directory and never overwrites an existing file.

const KNOWN_BOOKMAKERS = ['bet365', 'superbet', 'novibet'];
const NEGATIVE_CASES = 5;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ABORT_CODES = new Set([
  'AI_BUDGET_EXHAUSTED',
  'AI_AUTH_REFUSED',
  'AI_RATE_LIMITED',
  // Model qualification: a returned model that differs from the selected one
  // (or an out-of-chain selector) invalidates the whole run — it must never
  // become a per-case failure or produce a corpus.
  'AI_MODEL_MISMATCH',
  'AI_MODEL_NOT_ALLOWED',
]);
// Falhas de OCR que invalidam a rodada inteira: sem credencial válida ou com
// divergência de consenso nenhum caso pode ser medido (aborto global).
const OCR_ABORT_CODES = new Set([
  'AZURE_VISION_AUTH_REFUSED',
  'GOOGLE_VISION_AUTH_REFUSED',
  'OCR_PROVIDER_DIVERGENCE',
  'OCR_CONFIGURATION_INVALID',
]);
// Falhas de caso CONSECUTIVAS (OCR ou modelo) além do limite interrompem o
// run: resposta inválida recorrente indica problema sistêmico, não da imagem.
const MAX_CONSECUTIVE_FAILURES = 3;
const CODE = /^[A-Z][A-Z_]{2,59}$/;

const LAYOUT_PROFILES = {
  bet365: {
    id: 'bet365-v1',
    description:
      'Recorte de tela de bilhete/cupom da Bet365 (interface pt-BR, moeda BRL): bilhetes liquidados, recortes parciais sem prêmio visível e cupons de pré-aposta não confirmados. Corresponder somente quando o recorte exibir marcadores visuais da Bet365 (marca ou identidade da casa, tipografia e controles característicos da interface). Não corresponde a capturas de outra casa nem quando a casa não puder ser determinada visualmente; nesse caso não atribua este layout. Campos ausentes ou ilegíveis permanecem null; nenhuma data é inferida.',
    placedAtFormat: 'br-sao-paulo',
    allowFreebet: true,
  },
  superbet: {
    id: 'superbet-v1',
    description:
      'Recorte de tela de bilhete/cupom da Superbet (interface pt-BR, moeda BRL): bilhetes liquidados, recortes parciais sem prêmio visível, múltiplas com aposta grátis e cupons de pré-aposta não confirmados. Corresponder somente quando o recorte exibir marcadores visuais da Superbet (marca ou identidade da casa, tipografia e controles característicos da interface). Não corresponde a capturas de outra casa nem quando a casa não puder ser determinada visualmente; nesse caso não atribua este layout. Campos ausentes ou ilegíveis permanecem null; nenhuma data é inferida.',
    placedAtFormat: 'br-sao-paulo',
    allowFreebet: true,
  },
};

class ReplayError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'ReplayError';
    Object.assign(this, details);
  }
}

const refuse = (code) => {
  throw new ReplayError(code);
};

const safeCode = (value) =>
  typeof value === 'string' && CODE.test(value) ? value : 'AI_UNKNOWN_FAILURE';

async function guardedDirectory(directoryArg) {
  if (typeof directoryArg !== 'string' || !isAbsolute(directoryArg))
    refuse('REPLAY_DIRECTORY_INVALID');
  const directory = await realpath(directoryArg).catch(() => null);
  if (!directory) refuse('REPLAY_DIRECTORY_INVALID');
  const workspace = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const canonical = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const rel = relative(workspace, directory);
  if (
    !rel ||
    (!rel.startsWith(`..${sep}`) && !isAbsolute(rel)) ||
    // Windows exposes short (8.3) temp names whose realpath expands to the
    // long form; POSIX keeps refusing any path with a symlinked component.
    (process.platform !== 'win32' && canonical(resolve(directoryArg)) !== canonical(directory))
  )
    refuse('REPLAY_DIRECTORY_INVALID');
  const info = await lstat(directory);
  const argInfo = await lstat(directoryArg);
  if (info.isSymbolicLink() || argInfo.isSymbolicLink() || !info.isDirectory())
    refuse('REPLAY_DIRECTORY_INVALID');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) refuse('REPLAY_DIRECTORY_INVALID');
  return directory;
}

async function readDraft(directory, draftFile) {
  let draft;
  let raw;
  try {
    raw = await readFile(join(directory, draftFile));
    draft = JSON.parse(raw.toString('utf8'));
  } catch {
    refuse('REPLAY_DRAFT_INVALID');
  }
  if (!draft || typeof draft !== 'object' || !Array.isArray(draft.cases) || draft.cases.length < 1)
    refuse('REPLAY_DRAFT_INVALID');
  const duplicates = new Set();
  for (const entry of Array.isArray(draft.duplicates) ? draft.duplicates : []) {
    if (entry && typeof entry.file === 'string') duplicates.add(entry.file);
  }
  const cases = draft.cases.map((item) => {
    if (!item || typeof item !== 'object') refuse('REPLAY_DRAFT_INVALID');
    const { file, sha256, expected } = item;
    if (typeof file !== 'string' || !/^[A-Za-z0-9._-]+$/.test(file) || file.endsWith('.json'))
      refuse('REPLAY_DRAFT_INVALID');
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))
      refuse('REPLAY_DRAFT_INVALID');
    if (!ticketExtractionSchema.safeParse(expected).success) refuse('REPLAY_DRAFT_INVALID');
    if (duplicates.has(file)) refuse('REPLAY_DUPLICATE_IN_CASES');
    return { file, sha256, expected };
  });
  if (new Set(cases.map((item) => item.sha256)).size !== cases.length)
    refuse('REPLAY_DRAFT_INVALID');
  return {
    cases,
    duplicates,
    scope: draft.scope,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

async function verifyImage(directory, file, sha256) {
  const path = join(directory, file);
  const stat = await lstat(path).catch(() => null);
  if (
    !stat ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > MAX_IMAGE_BYTES
  )
    refuse('REPLAY_IMAGE_MISSING');
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256)
    refuse('REPLAY_IMAGE_HASH_MISMATCH');
  return bytes;
}

export async function runReplay(options) {
  const {
    bookmaker,
    ownDir: ownArg,
    otherDir: otherArg,
    bookmakerId,
    env = process.env,
    fetchImpl,
    dryRun = false,
    draftFile = 'ground-truth-draft.json',
    model = OPENROUTER_MODEL,
    pacingMs = fetchImpl ? 0 : 60_000,
    sleepImpl = delay,
  } = options ?? {};
  if (!KNOWN_BOOKMAKERS.includes(bookmaker)) refuse('REPLAY_BOOKMAKER_UNKNOWN');
  // Model qualification: only the approved chain is accepted and the check
  // happens before any network access, write or cost.
  if (!OPENROUTER_MODELS.includes(model)) refuse('REPLAY_MODEL_NOT_ALLOWED');
  if (typeof bookmakerId !== 'string' || !UUID.test(bookmakerId))
    refuse('REPLAY_BOOKMAKER_ID_INVALID');
  if (
    typeof draftFile !== 'string' ||
    !/^[A-Za-z0-9._-]+\.json$/.test(draftFile) ||
    draftFile === 'corpus.json' ||
    draftFile === 'evaluation.json'
  )
    refuse('REPLAY_ARGS_INVALID');
  if (!Number.isSafeInteger(pacingMs) || pacingMs < 0 || pacingMs > 300_000)
    refuse('REPLAY_PACING_INVALID');
  if (!fetchImpl && !dryRun && pacingMs < 15_000) refuse('REPLAY_PACING_INVALID');
  const profile = LAYOUT_PROFILES[bookmaker];
  const ownDir = await guardedDirectory(ownArg);
  const otherDir = await guardedDirectory(otherArg);
  if (ownDir === otherDir) refuse('REPLAY_DIRECTORY_INVALID');
  const output = join(ownDir, 'corpus.json');
  if (await lstat(output).catch(() => null)) refuse('REPLAY_OUTPUT_EXISTS');
  let apiKey;
  try {
    const config = readAiConfig(env);
    if (!config) refuse('AI_CONFIGURATION_INVALID');
    apiKey = config.apiKey;
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    refuse(safeCode(error?.message));
  }
  // OCR da rota atual: Azure primário + Google fallback conforme o env
  // (OCR_PRIMARY_PROVIDER/OCR_MODE). Configuração inválida falha aqui, antes
  // de qualquer chamada, custo ou escrita; sem OCR configurado o replay
  // preserva o comportamento visual-only anterior.
  let ocrProviders = null;
  try {
    ocrProviders = readOcrProvidersConfig(env);
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    refuse(safeCode(error?.message));
  }
  const own = await readDraft(ownDir, draftFile);
  const other = await readDraft(otherDir, draftFile);
  if (own.scope?.bookmaker !== undefined && own.scope.bookmaker !== bookmaker)
    refuse('REPLAY_DRAFT_INVALID');
  if (other.scope?.bookmaker !== undefined && other.scope.bookmaker === bookmaker)
    refuse('REPLAY_DRAFT_INVALID');
  if (other.cases.length < NEGATIVE_CASES) refuse('REPLAY_DRAFT_INVALID');
  const positives = [];
  for (const item of own.cases)
    positives.push({
      ...item,
      kind: 'positive',
      bytes: await verifyImage(ownDir, item.file, item.sha256),
    });
  const negatives = [];
  for (const item of other.cases.slice(0, NEGATIVE_CASES))
    negatives.push({
      ...item,
      kind: 'negative',
      bytes: await verifyImage(otherDir, item.file, item.sha256),
    });
  const seen = new Set();
  for (const item of [...positives, ...negatives]) {
    if (seen.has(item.sha256)) refuse('REPLAY_IMAGE_CONFLICT');
    seen.add(item.sha256);
  }
  const layout = {
    id: profile.id,
    bookmaker,
    bookmakerId,
    // Each artefato qualifies exactly one chain model; the policy digest is
    // model-specific, so corpora/policies never cross models.
    model,
    description: profile.description,
    placedAtFormat: profile.placedAtFormat,
    allowFreebet: profile.allowFreebet,
  };
  const summary = {
    bookmaker,
    layoutId: layout.id,
    bookmakerId,
    // O replay avalia o caminho com casa informada pelo usuário.
    bookmakerContext: 'user-informed',
    model,
    modelReturned: null,
    draftFile,
    draftSha256: own.sha256,
    otherDraftSha256: other.sha256,
    dryRun,
    pacingMs,
    positives: positives.length,
    negatives: negatives.length,
    duplicatesIgnored: own.duplicates.size,
    cases: positives.length + negatives.length,
    hashesVerified: positives.length + negatives.length,
    calls: 0,
    failures: 0,
    failureCodes: {},
    costUsdTotal: 0,
    costReported: 0,
    output: dryRun ? null : 'corpus.json',
    ocr: {
      enabled: ocrProviders !== null,
      primary: ocrProviders?.primary ?? null,
      fallback: ocrProviders?.fallback ?? null,
      mode: ocrProviders?.mode ?? null,
      calls: 0,
      fallbackUsed: 0,
      failures: 0,
      latencyMs: { min: null, max: null, avg: null },
    },
  };
  if (dryRun) return { summary };
  const cases = [];
  let costUsdTotal = 0;
  let costReported = 0;
  let consecutiveFailures = 0;
  let ocrLatencyMin = null;
  let ocrLatencyMax = null;
  let ocrLatencySum = 0;
  let ocrLatencyCount = 0;
  for (const [index, item] of [...positives, ...negatives].entries()) {
    // Pacing mínimo entre inícios de chamadas externas: a pausa antes do caso
    // cobre a chamada de OCR; a segunda pausa cobre a chamada ao modelo.
    if (index > 0 && pacingMs > 0) await sleepImpl(pacingMs);
    const started = performance.now();
    let actual;
    let modelAttempted = false;
    try {
      let ocr;
      let ocrMeta = null;
      if (ocrProviders) {
        // Rota atual: OCR estruturado (Azure primário + Google fallback
        // configurado) antes da extração multimodal; a imagem original segue
        // como fonte de verdade. Fail-closed: falha de OCR não vira chamada
        // paga sem OCR em silêncio.
        const ocrStarted = performance.now();
        let ocrResult;
        try {
          ocrResult = await extractConfiguredOcr({
            config: ocrProviders,
            image: item.bytes,
            ...(fetchImpl ? { fetchImpl } : {}),
          });
        } catch (error) {
          summary.ocr.failures += 1;
          throw error;
        }
        const ocrLatencyMs = Math.round(performance.now() - ocrStarted);
        ocrLatencyMin =
          ocrLatencyMin === null ? ocrLatencyMs : Math.min(ocrLatencyMin, ocrLatencyMs);
        ocrLatencyMax =
          ocrLatencyMax === null ? ocrLatencyMs : Math.max(ocrLatencyMax, ocrLatencyMs);
        ocrLatencySum += ocrLatencyMs;
        ocrLatencyCount += 1;
        summary.ocr.calls += 1;
        if (ocrResult.fallbackUsed) summary.ocr.fallbackUsed += 1;
        ocr = ocrResult.result;
        ocrMeta = {
          provider: ocrResult.provider,
          fallbackUsed: ocrResult.fallbackUsed,
          latencyMs: ocrLatencyMs,
        };
        if (pacingMs > 0) await sleepImpl(pacingMs);
      }
      modelAttempted = true;
      const result = await extractTicketForEvidence({
        apiKey,
        image: item.bytes,
        layouts: [layout],
        // Qualification measures exactly the selected model; the evidence
        // path validates the selector against the approved chain.
        model,
        // Not approved yet: the evidence-only path skips the policy digest,
        // which requires the approval fields validated by layoutDigest.
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(ocr ? { ocr } : {}),
      });
      summary.calls += 1;
      summary.modelReturned = result.model;
      const cost = typeof result.usage?.cost === 'number' ? result.usage.cost : null;
      if (cost !== null) {
        costUsdTotal += cost;
        costReported += 1;
      }
      consecutiveFailures = 0;
      actual = {
        imageSha256: item.sha256,
        model: result.model,
        provider: result.provider,
        layoutId: result.layoutId,
        extraction: result.extraction,
        latencyMs: result.elapsedMs,
        requestCount: 1,
        costUsd: cost,
        ...(ocrMeta ? { ocr: ocrMeta, ocrConsistent: result.ocrConsistent ?? null } : {}),
      };
    } catch (error) {
      if (modelAttempted) summary.calls += 1;
      const code = safeCode(error?.message);
      if (ABORT_CODES.has(code) || OCR_ABORT_CODES.has(code)) {
        throw new ReplayError('REPLAY_ABORTED', {
          abortCode: code,
          calls: summary.calls,
          completed: cases.length,
          ocrCalls: summary.ocr.calls,
          ocrFailures: summary.ocr.failures,
          rateLimit:
            code === 'AI_RATE_LIMITED' && error?.safeMetadata ? error.safeMetadata : undefined,
        });
      }
      summary.failures += 1;
      summary.failureCodes[code] = (summary.failureCodes[code] ?? 0) + 1;
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new ReplayError('REPLAY_ABORTED', {
          abortCode: code,
          calls: summary.calls,
          completed: cases.length,
          ocrCalls: summary.ocr.calls,
          ocrFailures: summary.ocr.failures,
        });
      }
      actual = {
        imageSha256: item.sha256,
        model: layout.model,
        layoutId: null,
        extraction: { error: code },
        latencyMs: Math.round(performance.now() - started),
        requestCount: 1,
        costUsd: null,
      };
    }
    cases.push({
      imageSha256: item.sha256,
      expectedLayoutId: item.kind === 'positive' ? layout.id : null,
      expected: item.expected,
      actual,
    });
  }
  const corpus = { schemaVersion: 1, bookmakerContext: 'user-informed', layout, cases };
  if (!corpusEvaluationInputSchema.safeParse(corpus).success) refuse('REPLAY_CORPUS_INVALID');
  await writeFile(output, JSON.stringify(corpus, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  summary.costUsdTotal = Math.round(costUsdTotal * 1e8) / 1e8;
  summary.costReported = costReported;
  summary.ocr.latencyMs = {
    min: ocrLatencyMin,
    max: ocrLatencyMax,
    avg: ocrLatencyCount ? Math.round(ocrLatencySum / ocrLatencyCount) : null,
  };
  return { summary };
}

const invokedAsCli = async () => {
  const self = await realpath(fileURLToPath(import.meta.url)).catch(() => null);
  const invoked = process.argv[1] && (await realpath(process.argv[1]).catch(() => null));
  return Boolean(self && invoked && self.toLowerCase() === invoked.toLowerCase());
};

async function main() {
  const flags = {
    dryRun: false,
    bookmakerId: undefined,
    draftFile: undefined,
    model: undefined,
    pacingMs: 60_000,
  };
  const positional = [];
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--bookmaker-id') flags.bookmakerId = args[(index += 1)];
    else if (arg === '--draft') flags.draftFile = args[(index += 1)];
    else if (arg === '--model') flags.model = args[(index += 1)];
    else if (arg === '--pacing-ms') flags.pacingMs = Number(args[(index += 1)]);
    else if (arg.startsWith('--')) refuse('REPLAY_ARGS_INVALID');
    else positional.push(arg);
  }
  const [bookmaker, ownDir, otherDir, ...rest] = positional;
  if (rest.length || !bookmaker || !ownDir || !otherDir || !flags.bookmakerId)
    refuse('REPLAY_ARGS_INVALID');
  const { summary } = await runReplay({
    bookmaker,
    ownDir,
    otherDir,
    bookmakerId: flags.bookmakerId,
    dryRun: flags.dryRun,
    draftFile: flags.draftFile,
    model: flags.model,
    pacingMs: flags.pacingMs,
  });
  console.log(JSON.stringify(summary));
  if (summary.failures > 0) process.exitCode = 1;
}

if (await invokedAsCli()) {
  try {
    await main();
  } catch (error) {
    if (error instanceof ReplayError) {
      const detail =
        error.name === 'ReplayError' && error.abortCode
          ? ` ${error.abortCode} calls=${error.calls} completed=${error.completed}${
              error.rateLimit && Object.keys(error.rateLimit).length
                ? ` rateLimit=${JSON.stringify(error.rateLimit)}`
                : ''
            }`
          : '';
      console.error(`CORPUS_REPLAY_FAILED ${error.message}${detail}`);
    } else {
      console.error('CORPUS_REPLAY_FAILED REPLAY_FAILED');
    }
    process.exitCode = 1;
  }
}
