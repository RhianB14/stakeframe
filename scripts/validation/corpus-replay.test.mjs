import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runReplay } from './corpus-replay.mjs';
import { evaluateCorpus } from './corpus-core.mjs';
import { syntheticExtraction } from './corpus-fixture.mjs';
import { OPENROUTER_MODEL, OPENROUTER_MODELS } from '../../packages/shared/dist/index.js';

// Synthetic fixtures only: these tests never touch real tickets, images or keys.
const script = fileURLToPath(new URL('./corpus-replay.mjs', import.meta.url));
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const BOOKMAKER_ID = '10000000-0000-4000-8000-000000000001';

const jpeg = (seed) => Buffer.from([255, 216, 255, 224, seed & 0xff, (seed >> 8) & 0xff, 255, 217]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function writePrivate(file, content) {
  writeFileSync(file, content);
  chmodSync(file, 0o600);
}

function makeHouse({
  bookmaker,
  count = 10,
  extraction = syntheticExtraction(),
  duplicates = 0,
  draftFile = 'ground-truth-draft.json',
}) {
  const directory = mkdtempSync(join(tmpdir(), `stk-replay-${bookmaker}-`));
  const cases = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = jpeg(index + (bookmaker === 'bet365' ? 100 : 200));
    const file = `photo_${bookmaker}_${index}.jpg`;
    writePrivate(join(directory, file), bytes);
    cases.push({ file, sha256: sha(bytes), captureKind: 'settled_ticket', expected: extraction });
  }
  const entries = [];
  for (let index = 0; index < duplicates; index += 1) {
    const bytes = jpeg(index + 900);
    const file = `photo_copy_${index}.jpg`;
    writePrivate(join(directory, file), bytes);
    entries.push({
      file,
      sha256: sha(bytes),
      duplicateOf: 'elsewhere',
      reason: 'Cópia byte a byte',
    });
  }
  const draft = {
    schemaVersion: 1,
    status: 'draft_pending_owner_review',
    scope: { bookmaker },
    cases,
    ...(entries.length ? { duplicates: entries } : {}),
  };
  writePrivate(join(directory, draftFile), JSON.stringify(draft, null, 2) + '\n');
  return directory;
}

function makeEnv() {
  const directory = mkdtempSync(join(tmpdir(), 'stk-replay-key-'));
  const file = join(directory, 'api_key');
  writePrivate(file, `sk-or-v1-${'a'.repeat(64)}`);
  return {
    AI_ENABLED: 'true',
    AI_PROVIDER: 'openrouter',
    OPENROUTER_MODEL,
    OPENROUTER_ALLOW_FALLBACKS: 'true',
    OPENROUTER_API_KEY_FILE: file,
    AUTOMATIC_IMPORT_ENABLED: 'false',
  };
}

function mockFetch({ failAt = 0, failStatus = 500, positiveLayoutId }) {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    if (failAt === calls) return new Response('{}', { status: failStatus });
    const layoutId = calls <= 10 ? positiveLayoutId : null;
    return Response.json({
      id: `fictional-${calls}`,
      model: OPENROUTER_MODEL,
      choices: [
        {
          finish_reason: 'stop',
          message: { content: JSON.stringify({ layoutId, extraction: syntheticExtraction() }) },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.001 },
    });
  };
  impl.count = () => calls;
  return impl;
}

const run = (args) => {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
};

test('replays draft-referenced images through the worker path and writes corpus.json', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({
    bookmaker: 'superbet',
    extraction: { ...syntheticExtraction(), bookmaker: 'OtherHouse' },
  });
  const env = makeEnv();
  const fetchImpl = mockFetch({ positiveLayoutId: 'bet365-v1' });
  const { summary } = await runReplay({
    bookmaker: 'bet365',
    ownDir: own,
    otherDir: other,
    bookmakerId: BOOKMAKER_ID,
    env,
    fetchImpl,
  });
  assert.equal(summary.cases, 15);
  assert.equal(summary.positives, 10);
  assert.equal(summary.negatives, 5);
  assert.equal(summary.calls, 15);
  assert.equal(summary.failures, 0);
  assert.equal(summary.costUsdTotal, 0.015);
  assert.equal(summary.costReported, 15);
  assert.equal(fetchImpl.count(), 15);
  const corpus = JSON.parse(readFileSync(join(own, 'corpus.json'), 'utf8'));
  assert.equal(corpus.layout.id, 'bet365-v1');
  assert.equal(corpus.layout.bookmaker, 'bet365');
  assert.equal(corpus.layout.bookmakerId, BOOKMAKER_ID);
  assert.equal(corpus.layout.model, OPENROUTER_MODEL);
  assert.equal(corpus.bookmakerContext, 'user-informed');
  assert.equal(corpus.cases.length, 15);
  for (const item of corpus.cases.slice(0, 10)) {
    assert.equal(item.expectedLayoutId, 'bet365-v1');
    assert.equal(item.expected.bookmaker, 'Fictional');
    assert.deepEqual(item.actual.extraction, syntheticExtraction());
    assert.equal(item.actual.layoutId, 'bet365-v1');
    assert.equal(item.actual.requestCount, 1);
    assert.equal(item.actual.costUsd, 0.001);
    assert.equal(item.actual.model, OPENROUTER_MODEL);
    assert.equal(typeof item.actual.latencyMs, 'number');
  }
  for (const item of corpus.cases.slice(10)) {
    assert.equal(item.expectedLayoutId, null);
    assert.equal(item.expected.bookmaker, 'OtherHouse');
    assert.equal(item.actual.layoutId, null);
  }
  assert.equal(existsSync(join(own, 'evaluation.json')), false);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes('sk-or-'), false);
  assert.equal(serialized.includes('data:'), false);
  assert.equal(readFileSync(join(own, 'corpus.json'), 'utf8').includes('sk-or-'), false);
});

test('never overwrites an existing corpus.json', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet', count: 10 });
  writePrivate(join(own, 'corpus.json'), '{}\n');
  await assert.rejects(
    runReplay({
      bookmaker: 'bet365',
      ownDir: own,
      otherDir: other,
      bookmakerId: BOOKMAKER_ID,
      env: makeEnv(),
      fetchImpl: mockFetch({ positiveLayoutId: 'bet365-v1' }),
    }),
    (error) => error.name === 'ReplayError' && error.message === 'REPLAY_OUTPUT_EXISTS',
  );
});

test('fails closed on image hash mismatch or missing image before any call', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  writePrivate(join(own, 'photo_bet365_3.jpg'), jpeg(12345));
  const fetchImpl = mockFetch({ positiveLayoutId: 'bet365-v1' });
  await assert.rejects(
    runReplay({
      bookmaker: 'bet365',
      ownDir: own,
      otherDir: other,
      bookmakerId: BOOKMAKER_ID,
      env: makeEnv(),
      fetchImpl,
    }),
    (error) => error.name === 'ReplayError' && error.message === 'REPLAY_IMAGE_HASH_MISMATCH',
  );
  assert.equal(fetchImpl.count(), 0);
  const absent = makeHouse({ bookmaker: 'bet365' });
  const other2 = makeHouse({ bookmaker: 'superbet' });
  writePrivate(
    join(absent, 'ground-truth-draft.json'),
    JSON.stringify({
      schemaVersion: 1,
      scope: { bookmaker: 'bet365' },
      cases: [
        { file: 'photo_bet365_0.jpg', sha256: sha(jpeg(100)), expected: syntheticExtraction() },
        { file: 'missing.jpg', sha256: 'a'.repeat(64), expected: syntheticExtraction() },
      ],
    }),
  );
  await assert.rejects(
    runReplay({
      bookmaker: 'bet365',
      ownDir: absent,
      otherDir: other2,
      bookmakerId: BOOKMAKER_ID,
      env: makeEnv(),
      fetchImpl,
    }),
    (error) => error.name === 'ReplayError' && error.message === 'REPLAY_IMAGE_MISSING',
  );
  assert.equal(fetchImpl.count(), 0);
});

test('ignores duplicate files listed in the draft and refuses overlaps with cases', async () => {
  const own = makeHouse({ bookmaker: 'bet365', duplicates: 3 });
  const other = makeHouse({ bookmaker: 'superbet' });
  const { summary } = await runReplay({
    bookmaker: 'bet365',
    ownDir: own,
    otherDir: other,
    bookmakerId: BOOKMAKER_ID,
    env: makeEnv(),
    fetchImpl: mockFetch({ positiveLayoutId: 'bet365-v1' }),
  });
  assert.equal(summary.duplicatesIgnored, 3);
  assert.equal(summary.calls, 15);
  const reload = makeHouse({ bookmaker: 'bet365' });
  const other2 = makeHouse({ bookmaker: 'superbet' });
  const overlap = JSON.parse(readFileSync(join(reload, 'ground-truth-draft.json'), 'utf8'));
  overlap.cases[0] = {
    file: 'dup.jpg',
    sha256: sha(jpeg(55)),
    expected: syntheticExtraction(),
  };
  writePrivate(join(reload, 'dup.jpg'), jpeg(55));
  overlap.duplicates = [{ file: 'dup.jpg', sha256: sha(jpeg(55)), reason: 'overlap' }];
  writePrivate(join(reload, 'ground-truth-draft.json'), JSON.stringify(overlap));
  await assert.rejects(
    runReplay({
      bookmaker: 'bet365',
      ownDir: reload,
      otherDir: other2,
      bookmakerId: BOOKMAKER_ID,
      env: makeEnv(),
      fetchImpl: mockFetch({ positiveLayoutId: 'bet365-v1' }),
    }),
    (error) => error.name === 'ReplayError' && error.message === 'REPLAY_DUPLICATE_IN_CASES',
  );
});

test('preserves per-image call failures as sanitized errors and keeps going', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  const fetchImpl = mockFetch({ failAt: 3, failStatus: 500, positiveLayoutId: 'bet365-v1' });
  const { summary } = await runReplay({
    bookmaker: 'bet365',
    ownDir: own,
    otherDir: other,
    bookmakerId: BOOKMAKER_ID,
    env: makeEnv(),
    fetchImpl,
  });
  assert.equal(summary.calls, 15);
  assert.equal(summary.failures, 1);
  assert.deepEqual(summary.failureCodes, { AI_PROVIDER_UNAVAILABLE: 1 });
  assert.equal(summary.costUsdTotal, 0.014);
  const corpus = JSON.parse(readFileSync(join(own, 'corpus.json'), 'utf8'));
  assert.deepEqual(corpus.cases[2].actual.extraction, { error: 'AI_PROVIDER_UNAVAILABLE' });
  assert.equal(corpus.cases[2].actual.costUsd, null);
  assert.equal(corpus.cases[1].actual.costUsd, 0.001);
});

test('aborts without writing on budget exhaustion and never retries', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  const fetchImpl = mockFetch({ failAt: 2, failStatus: 402, positiveLayoutId: 'bet365-v1' });
  await assert.rejects(
    runReplay({
      bookmaker: 'bet365',
      ownDir: own,
      otherDir: other,
      bookmakerId: BOOKMAKER_ID,
      env: makeEnv(),
      fetchImpl,
    }),
    (error) =>
      error.name === 'ReplayError' &&
      error.message === 'REPLAY_ABORTED' &&
      error.abortCode === 'AI_BUDGET_EXHAUSTED' &&
      error.completed === 1,
  );
  assert.equal(fetchImpl.count(), 2);
  assert.equal(existsSync(join(own, 'corpus.json')), false);
});

test('paces calls internally and preserves only sanitized 429 metadata', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 2)
      return new Response('private provider body', {
        status: 429,
        headers: {
          'retry-after': '120',
          'x-ratelimit-remaining': '0',
          'x-private-header': 'must-not-escape',
        },
      });
    return Response.json({
      id: 'fictional-pacing',
      model: OPENROUTER_MODEL,
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              layoutId: 'bet365-v1',
              extraction: syntheticExtraction(),
            }),
          },
        },
      ],
    });
  };
  await assert.rejects(
    runReplay({
      bookmaker: 'bet365',
      ownDir: own,
      otherDir: other,
      bookmakerId: BOOKMAKER_ID,
      env: makeEnv(),
      fetchImpl,
      pacingMs: 45_000,
      sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
    }),
    (error) => {
      assert.equal(error.name, 'ReplayError');
      assert.equal(error.abortCode, 'AI_RATE_LIMITED');
      assert.equal(error.calls, 2);
      assert.equal(error.completed, 1);
      assert.deepEqual(error.rateLimit, { retryAfterSeconds: 120, remaining: 0 });
      assert.equal(JSON.stringify(error).includes('private'), false);
      return true;
    },
  );
  assert.deepEqual(sleeps, [45_000]);
  assert.equal(existsSync(join(own, 'corpus.json')), false);
});

test('dry run validates plan and config without any call or write', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  const fetchImpl = mockFetch({ positiveLayoutId: 'bet365-v1' });
  const { summary } = await runReplay({
    bookmaker: 'bet365',
    ownDir: own,
    otherDir: other,
    bookmakerId: BOOKMAKER_ID,
    env: makeEnv(),
    fetchImpl,
    dryRun: true,
  });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.bookmakerContext, 'user-informed');
  assert.equal(summary.cases, 15);
  assert.equal(summary.calls, 0);
  assert.equal(summary.output, null);
  assert.equal(fetchImpl.count(), 0);
  assert.equal(existsSync(join(own, 'corpus.json')), false);
  assert.equal(existsSync(join(own, 'evaluation.json')), false);
});

test('dry run records the selected model without calls, writes or cost', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  const fetchImpl = mockFetch({ positiveLayoutId: 'bet365-v1' });
  const { summary } = await runReplay({
    bookmaker: 'bet365',
    ownDir: own,
    otherDir: other,
    bookmakerId: BOOKMAKER_ID,
    env: makeEnv(),
    fetchImpl,
    dryRun: true,
    model: OPENROUTER_MODELS[2],
  });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.model, OPENROUTER_MODELS[2]);
  assert.equal(summary.modelReturned, null);
  assert.equal(summary.calls, 0);
  assert.equal(summary.costUsdTotal, 0);
  assert.equal(fetchImpl.count(), 0);
  assert.equal(existsSync(join(own, 'corpus.json')), false);
});

test('refuses invalid arguments and paths from the CLI without touching the network', () => {
  const unknown = run(['kalshi', tmpdir(), tmpdir(), '--bookmaker-id', BOOKMAKER_ID]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /CORPUS_REPLAY_FAILED REPLAY_BOOKMAKER_UNKNOWN/);
  const relative = run([
    'bet365',
    'relative-corpus',
    'relative-other',
    '--bookmaker-id',
    BOOKMAKER_ID,
  ]);
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /CORPUS_REPLAY_FAILED REPLAY_DIRECTORY_INVALID/);
  const repository = run([
    'bet365',
    join(workspace, 'scripts', 'validation'),
    join(workspace, 'scripts'),
    '--bookmaker-id',
    BOOKMAKER_ID,
  ]);
  assert.equal(repository.status, 1);
  assert.match(repository.stderr, /CORPUS_REPLAY_FAILED REPLAY_DIRECTORY_INVALID/);
  const missing = run(['bet365', tmpdir(), tmpdir()]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /CORPUS_REPLAY_FAILED REPLAY_ARGS_INVALID/);
});

test('flags cross-house false positives instead of adapting expectations', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const layoutId = calls <= 10 || calls === 11 || calls === 13 ? 'bet365-v1' : null;
    return Response.json({
      id: `fictional-${calls}`,
      model: OPENROUTER_MODEL,
      choices: [
        {
          finish_reason: 'stop',
          message: { content: JSON.stringify({ layoutId, extraction: syntheticExtraction() }) },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.001 },
    });
  };
  await runReplay({
    bookmaker: 'bet365',
    ownDir: own,
    otherDir: other,
    bookmakerId: BOOKMAKER_ID,
    env: makeEnv(),
    fetchImpl,
  });
  const corpus = JSON.parse(readFileSync(join(own, 'corpus.json'), 'utf8'));
  assert.equal(corpus.cases[10].expectedLayoutId, null);
  assert.equal(corpus.cases[10].actual.layoutId, 'bet365-v1');
  const report = evaluateCorpus(corpus);
  assert.equal(report.eligibleForOwnerReview, false);
  assert.equal(report.fieldCounts.layout.mismatches, 2);
  assert.equal(report.cases[10].correct, false);
  assert.equal(report.cases[12].correct, false);
});

test('qualifies exactly one selected chain model per request without cross-model fallback', async () => {
  for (const model of OPENROUTER_MODELS) {
    const own = makeHouse({ bookmaker: 'bet365' });
    const other = makeHouse({ bookmaker: 'superbet' });
    const bodies = [];
    const fetchImpl = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: `fictional-${model}`,
        model,
        provider: 'Fictional Provider',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({ layoutId: 'bet365-v1', extraction: syntheticExtraction() }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.001 },
      });
    };
    const { summary } = await runReplay({
      bookmaker: 'bet365',
      ownDir: own,
      otherDir: other,
      bookmakerId: BOOKMAKER_ID,
      env: makeEnv(),
      fetchImpl,
      model,
    });
    assert.equal(summary.model, model);
    assert.equal(summary.modelReturned, model);
    assert.equal(bodies.length, 15);
    for (const body of bodies) assert.deepEqual(body.models, [model]);
    const corpus = JSON.parse(readFileSync(join(own, 'corpus.json'), 'utf8'));
    assert.equal(corpus.layout.model, model);
    assert.equal(corpus.cases[0].actual.model, model);
    assert.equal(corpus.cases[0].actual.provider, 'Fictional Provider');
  }
});

test('refuses a model outside the approved chain before any network call or write', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  const fetchImpl = mockFetch({ positiveLayoutId: 'bet365-v1' });
  await assert.rejects(
    runReplay({
      bookmaker: 'bet365',
      ownDir: own,
      otherDir: other,
      bookmakerId: BOOKMAKER_ID,
      env: makeEnv(),
      fetchImpl,
      model: 'openai/gpt-fictional',
    }),
    (error) => error.name === 'ReplayError' && error.message === 'REPLAY_MODEL_NOT_ALLOWED',
  );
  assert.equal(fetchImpl.count(), 0);
  assert.equal(existsSync(join(own, 'corpus.json')), false);
  const cli = run([
    'bet365',
    tmpdir(),
    tmpdir(),
    '--bookmaker-id',
    BOOKMAKER_ID,
    '--model',
    'openai/gpt-fictional',
  ]);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /CORPUS_REPLAY_FAILED REPLAY_MODEL_NOT_ALLOWED/);
});

test('aborts sanitized when the returned model differs and never produces a corpus', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  const fetchImpl = async () =>
    Response.json({
      id: 'fictional-mismatch',
      model: OPENROUTER_MODEL,
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({ layoutId: 'bet365-v1', extraction: syntheticExtraction() }),
          },
        },
      ],
    });
  await assert.rejects(
    runReplay({
      bookmaker: 'bet365',
      ownDir: own,
      otherDir: other,
      bookmakerId: BOOKMAKER_ID,
      env: makeEnv(),
      fetchImpl,
      model: OPENROUTER_MODELS[1],
    }),
    (error) => {
      assert.equal(error.name, 'ReplayError');
      assert.equal(error.message, 'REPLAY_ABORTED');
      assert.equal(error.abortCode, 'AI_MODEL_MISMATCH');
      assert.equal(error.calls, 1);
      assert.equal(error.completed, 0);
      return true;
    },
  );
  assert.equal(existsSync(join(own, 'corpus.json')), false);
  assert.equal(existsSync(join(own, 'evaluation.json')), false);
});

test('supports versioned drafts and records their hashes without touching defaults', async () => {
  const own = makeHouse({ bookmaker: 'bet365', draftFile: 'ground-truth-v2.json' });
  const other = makeHouse({ bookmaker: 'superbet', draftFile: 'ground-truth-v2.json' });
  const defaultAttempt = await runReplay({
    bookmaker: 'bet365',
    ownDir: own,
    otherDir: other,
    bookmakerId: BOOKMAKER_ID,
    env: makeEnv(),
    fetchImpl: mockFetch({ positiveLayoutId: 'bet365-v1' }),
  }).catch((error) => error);
  assert.equal(defaultAttempt.message, 'REPLAY_DRAFT_INVALID');
  const { summary } = await runReplay({
    bookmaker: 'bet365',
    ownDir: own,
    otherDir: other,
    bookmakerId: BOOKMAKER_ID,
    env: makeEnv(),
    fetchImpl: mockFetch({ positiveLayoutId: 'bet365-v1' }),
    draftFile: 'ground-truth-v2.json',
  });
  assert.equal(summary.draftFile, 'ground-truth-v2.json');
  assert.equal(summary.draftSha256, sha(readFileSync(join(own, 'ground-truth-v2.json'))));
  assert.equal(summary.otherDraftSha256, sha(readFileSync(join(other, 'ground-truth-v2.json'))));
});

// ---- Rota OCR (Azure primário + Google fallback) ----

const AZURE_TEST_ENDPOINT = 'https://stakeframe-fixture.cognitiveservices.azure.com';
const AZURE_OPERATION_URL = `${AZURE_TEST_ENDPOINT}/vision/v3.2/read/analyzeResults/fixture-operation`;
const OCR_PRIVATE_MARKER = 'OCR-CONTEUDO-PRIVADO-DE-BILHETE';

function ocrKeyFile(name, contents) {
  const directory = mkdtempSync(join(tmpdir(), `stk-replay-${name}-`));
  const file = join(directory, 'api_key');
  writePrivate(file, contents);
  return file;
}

function makeOcrEnv() {
  return {
    ...makeEnv(),
    AZURE_VISION_ENABLED: 'true',
    AZURE_VISION_ENDPOINT: AZURE_TEST_ENDPOINT,
    AZURE_VISION_API_KEY_FILE: ocrKeyFile('azure', 'fixture-azure-key-0123456789abcdef\n'),
    GOOGLE_VISION_ENABLED: 'true',
    GOOGLE_VISION_API_KEY_FILE: ocrKeyFile('google', 'fixture-google-key-0123456789abcdef\n'),
    OCR_PRIMARY_PROVIDER: 'azure',
    OCR_MODE: 'failover',
  };
}

const azureAnalysisFixture = {
  status: 'succeeded',
  analyzeResult: {
    version: '3.2.0',
    readResults: [
      {
        page: 1,
        angle: 0,
        width: 1000,
        height: 2000,
        unit: 'pixel',
        lines: [
          {
            boundingBox: [10, 20, 510, 20, 510, 60, 10, 60],
            text: `fixture 10.00 2.00 Fictional A × B Result A ${OCR_PRIVATE_MARKER}`,
            words: [
              {
                boundingBox: [10, 20, 60, 20, 60, 60, 10, 60],
                text: 'fixture',
                confidence: 0.99,
              },
            ],
          },
        ],
      },
    ],
  },
};

const googleVisionFixture = {
  responses: [
    {
      fullTextAnnotation: {
        text: `fixture 10.00 2.00 Fictional A × B Result A ${OCR_PRIVATE_MARKER}`,
        pages: [
          {
            width: 1000,
            height: 2000,
            blocks: [
              {
                boundingBox: {
                  vertices: [
                    { x: 10, y: 20 },
                    { x: 20, y: 20 },
                  ],
                },
                paragraphs: [
                  {
                    words: [
                      {
                        confidence: 0.95,
                        boundingBox: {
                          vertices: [
                            { x: 10, y: 20 },
                            { x: 20, y: 20 },
                          ],
                        },
                        symbols: [{ text: 'fixture' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  ],
};

function mockOcrFetch({ azureStatus = 200, googleStatus = 200, failOcrAt = 0 } = {}) {
  let azureSubmits = 0;
  let googleRequests = 0;
  let modelCalls = 0;
  let pendingFallbackFailure = false;
  const impl = async (url) => {
    const target = String(url);
    if (target.includes('cognitiveservices')) {
      if (target.includes('analyzeResults')) return Response.json(azureAnalysisFixture);
      azureSubmits += 1;
      if (azureStatus !== 200) return new Response('{}', { status: azureStatus });
      if (azureSubmits === failOcrAt) {
        pendingFallbackFailure = true;
        return new Response('{}', { status: 503 });
      }
      return new Response(null, {
        status: 202,
        headers: { 'operation-location': AZURE_OPERATION_URL },
      });
    }
    if (target.includes('googleapis.com')) {
      googleRequests += 1;
      if (googleStatus !== 200) return new Response('{}', { status: googleStatus });
      if (pendingFallbackFailure) {
        pendingFallbackFailure = false;
        return new Response('{}', { status: 500 });
      }
      return Response.json(googleVisionFixture);
    }
    modelCalls += 1;
    return Response.json({
      id: `fictional-ocr-${modelCalls}`,
      model: OPENROUTER_MODEL,
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              layoutId: modelCalls <= 10 ? 'bet365-v1' : null,
              extraction: syntheticExtraction(),
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.001 },
    });
  };
  impl.counts = () => ({ azureSubmits, googleRequests, modelCalls });
  return impl;
}

const ocrRun = (own, other, env, fetchImpl, extra = {}) =>
  runReplay({
    bookmaker: 'bet365',
    ownDir: own,
    otherDir: other,
    bookmakerId: BOOKMAKER_ID,
    env,
    fetchImpl,
    ...extra,
  });

test('runs the OCR providers before the model and records only sanitized metadata', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  const fetchImpl = mockOcrFetch();
  const sleeps = [];
  const { summary } = await ocrRun(own, other, makeOcrEnv(), fetchImpl, {
    pacingMs: 45_000,
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
  });
  const counts = fetchImpl.counts();
  assert.equal(counts.azureSubmits, 15);
  assert.equal(counts.googleRequests, 0);
  assert.equal(counts.modelCalls, 15);
  assert.equal(summary.ocr.enabled, true);
  assert.equal(summary.ocr.primary, 'azure');
  assert.equal(summary.ocr.fallback, 'google');
  assert.equal(summary.ocr.mode, 'failover');
  assert.equal(summary.ocr.calls, 15);
  assert.equal(summary.ocr.fallbackUsed, 0);
  assert.equal(summary.ocr.failures, 0);
  assert.ok(Number.isInteger(summary.ocr.latencyMs.avg));
  // Pacing entre inícios de chamadas externas: pausa antes do OCR (14) e
  // pausa entre OCR e modelo (15).
  assert.equal(sleeps.length, 29);
  assert.ok(sleeps.every((value) => value === 45_000));
  const raw = readFileSync(join(own, 'corpus.json'), 'utf8');
  assert.equal(raw.includes(OCR_PRIVATE_MARKER), false);
  const corpus = JSON.parse(raw);
  const first = corpus.cases[0].actual;
  assert.equal(first.ocr.provider, 'azure');
  assert.equal(first.ocr.fallbackUsed, false);
  assert.ok(Number.isInteger(first.ocr.latencyMs));
  assert.equal(first.ocrConsistent, true);
});

test('uses the configured Google fallback for a recoverable Azure failure', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  const fetchImpl = mockOcrFetch({ azureStatus: 503 });
  const { summary } = await ocrRun(own, other, makeOcrEnv(), fetchImpl);
  const counts = fetchImpl.counts();
  assert.equal(counts.azureSubmits, 15);
  assert.equal(counts.googleRequests, 15);
  assert.equal(counts.modelCalls, 15);
  assert.equal(summary.ocr.calls, 15);
  assert.equal(summary.ocr.fallbackUsed, 15);
  assert.equal(summary.ocr.failures, 0);
  const corpus = JSON.parse(readFileSync(join(own, 'corpus.json'), 'utf8'));
  assert.equal(corpus.cases[0].actual.ocr.provider, 'google');
  assert.equal(corpus.cases[0].actual.ocr.fallbackUsed, true);
});

test('keeps an OCR failure as a sanitized case failure without a model call', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  const fetchImpl = mockOcrFetch({ failOcrAt: 3 });
  const { summary } = await ocrRun(own, other, makeOcrEnv(), fetchImpl);
  const counts = fetchImpl.counts();
  assert.equal(counts.azureSubmits, 15);
  assert.equal(counts.googleRequests, 1);
  assert.equal(counts.modelCalls, 14);
  assert.equal(summary.calls, 14);
  assert.equal(summary.failures, 1);
  assert.deepEqual(summary.failureCodes, { GOOGLE_VISION_PROVIDER_UNAVAILABLE: 1 });
  assert.equal(summary.ocr.calls, 14);
  assert.equal(summary.ocr.failures, 1);
  const corpus = JSON.parse(readFileSync(join(own, 'corpus.json'), 'utf8'));
  assert.deepEqual(corpus.cases[2].actual.extraction, {
    error: 'GOOGLE_VISION_PROVIDER_UNAVAILABLE',
  });
  assert.equal(corpus.cases[2].actual.model, OPENROUTER_MODEL);
  assert.equal('ocr' in corpus.cases[2].actual, false);
});

test('aborts the round after consecutive case failures', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  const fetchImpl = mockOcrFetch({ azureStatus: 503, googleStatus: 500 });
  await assert.rejects(
    ocrRun(own, other, makeOcrEnv(), fetchImpl),
    (error) =>
      error.name === 'ReplayError' &&
      error.message === 'REPLAY_ABORTED' &&
      error.abortCode === 'GOOGLE_VISION_PROVIDER_UNAVAILABLE' &&
      error.completed === 2 &&
      error.ocrFailures === 3,
  );
  const counts = fetchImpl.counts();
  assert.equal(counts.modelCalls, 0);
  assert.equal(existsSync(join(own, 'corpus.json')), false);
});

test('aborts immediately on an OCR authentication refusal', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  const fetchImpl = mockOcrFetch({ azureStatus: 401 });
  await assert.rejects(
    ocrRun(own, other, makeOcrEnv(), fetchImpl),
    (error) =>
      error.name === 'ReplayError' &&
      error.message === 'REPLAY_ABORTED' &&
      error.abortCode === 'AZURE_VISION_AUTH_REFUSED' &&
      error.completed === 0,
  );
  const counts = fetchImpl.counts();
  assert.equal(counts.azureSubmits, 1);
  assert.equal(counts.googleRequests, 0);
  assert.equal(counts.modelCalls, 0);
  assert.equal(existsSync(join(own, 'corpus.json')), false);
});

test('fails closed on invalid OCR configuration before any call or write', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  const fetchImpl = mockOcrFetch();
  await assert.rejects(
    ocrRun(own, other, { ...makeOcrEnv(), AZURE_VISION_ENDPOINT: '' }, fetchImpl),
    (error) =>
      error.name === 'ReplayError' && error.message === 'AZURE_VISION_CONFIGURATION_INVALID',
  );
  assert.equal(fetchImpl.counts().modelCalls, 0);
  assert.equal(existsSync(join(own, 'corpus.json')), false);
});

test('dry run reports the OCR configuration without calls, writes or cost', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  const fetchImpl = mockOcrFetch();
  const { summary } = await ocrRun(own, other, makeOcrEnv(), fetchImpl, { dryRun: true });
  assert.equal(summary.ocr.enabled, true);
  assert.equal(summary.ocr.calls, 0);
  assert.equal(summary.costUsdTotal, 0);
  const counts = fetchImpl.counts();
  assert.equal(counts.azureSubmits + counts.googleRequests + counts.modelCalls, 0);
  assert.equal(existsSync(join(own, 'corpus.json')), false);
});

test('keeps the visual-only behavior when OCR is not configured', async () => {
  const own = makeHouse({ bookmaker: 'bet365' });
  const other = makeHouse({ bookmaker: 'superbet' });
  const fetchImpl = mockFetch({ positiveLayoutId: 'bet365-v1' });
  const { summary } = await ocrRun(own, other, makeEnv(), fetchImpl);
  assert.equal(summary.ocr.enabled, false);
  assert.equal(summary.ocr.calls, 0);
  assert.equal(fetchImpl.count(), 15);
  const corpus = JSON.parse(readFileSync(join(own, 'corpus.json'), 'utf8'));
  assert.equal('ocr' in corpus.cases[0].actual, false);
  assert.equal('ocrConsistent' in corpus.cases[0].actual, false);
});
