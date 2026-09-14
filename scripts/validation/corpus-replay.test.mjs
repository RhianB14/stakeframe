import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runReplay } from './corpus-replay.mjs';
import { syntheticExtraction } from './corpus-fixture.mjs';
import { OPENROUTER_MODEL } from '../../packages/shared/dist/index.js';

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

function makeHouse({ bookmaker, count = 10, extraction = syntheticExtraction(), duplicates = 0 }) {
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
  writePrivate(join(directory, 'ground-truth-draft.json'), JSON.stringify(draft, null, 2) + '\n');
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
    OPENROUTER_ALLOW_FALLBACKS: 'false',
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
  assert.equal(summary.cases, 15);
  assert.equal(summary.calls, 0);
  assert.equal(summary.output, null);
  assert.equal(fetchImpl.count(), 0);
  assert.equal(existsSync(join(own, 'corpus.json')), false);
  assert.equal(existsSync(join(own, 'evaluation.json')), false);
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
