import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { syntheticCorpus } from './corpus-fixture.mjs';

const script = fileURLToPath(new URL('./corpus.mjs', import.meta.url));
const workspace = fileURLToPath(new URL('../../', import.meta.url));

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function writeCorpusDirectory(corpus) {
  const directory = mkdtempSync(join(tmpdir(), 'stk-corpus-cli-'));
  const file = join(directory, 'corpus.json');
  writeFileSync(file, JSON.stringify(corpus, null, 2) + '\n');
  chmodSync(file, 0o600);
  return { directory, file };
}

test('evaluates a valid private corpus, writes a sanitized evaluation and prints only totals', () => {
  const { directory } = writeCorpusDirectory(syntheticCorpus());
  const result = run([directory]);
  assert.equal(result.status, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.eligibleForOwnerReview, true);
  assert.equal(summary.bookmaker, 'bet365');
  assert.equal(summary.layoutId, 'bet365-fixture');
  assert.match(summary.corpusSha256, /^[a-f0-9]{64}$/);
  assert.match(summary.evaluationSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.stdout.includes('Fictional A'), false);
  const evaluation = readFileSync(join(directory, 'evaluation.json'), 'utf8');
  assert.equal(evaluation.includes('Fictional A'), false);
});

test('never overwrites an existing evaluation file', () => {
  const { directory } = writeCorpusDirectory(syntheticCorpus());
  assert.equal(run([directory]).status, 0);
  const before = readFileSync(join(directory, 'evaluation.json'), 'utf8');
  const second = run([directory]);
  assert.equal(second.status, 1);
  assert.ok(second.stderr.includes('CORPUS_EVALUATION_FAILED'));
  assert.equal(readFileSync(join(directory, 'evaluation.json'), 'utf8'), before);
});

test('refuses relative paths, repository paths and invalid corpora without writing anything', () => {
  assert.equal(run(['relative-corpus']).status, 1);
  assert.equal(run([join(workspace, 'scripts', 'validation')]).status, 1);
  const { directory, file } = writeCorpusDirectory(syntheticCorpus());
  writeFileSync(file, 'private-invalid-content');
  const invalid = run([directory]);
  assert.equal(invalid.status, 1);
  assert.equal(existsSync(join(directory, 'evaluation.json')), false);
  const unknown = writeCorpusDirectory(syntheticCorpus());
  const corpus = JSON.parse(readFileSync(unknown.file, 'utf8'));
  corpus.layout.bookmaker = 'kalshi';
  writeFileSync(unknown.file, JSON.stringify(corpus));
  const refused = run([unknown.directory]);
  assert.equal(refused.status, 1);
  assert.equal(existsSync(join(unknown.directory, 'evaluation.json')), false);
});

test('records an ineligible evaluation but reports failure and stays non-overwritable', () => {
  const corpus = syntheticCorpus();
  corpus.cases = [...corpus.cases.slice(0, 15), ...corpus.cases.slice(20)];
  const { directory } = writeCorpusDirectory(corpus);
  const result = run([directory]);
  assert.equal(result.status, 1);
  const evaluation = JSON.parse(readFileSync(join(directory, 'evaluation.json'), 'utf8'));
  assert.equal(evaluation.eligibleForOwnerReview, false);
  assert.equal(evaluation.coverage.positive, 15);
  assert.equal(run([directory]).status, 1);
});
