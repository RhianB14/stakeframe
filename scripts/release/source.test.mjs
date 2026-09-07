import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSource, requiredChecks } from './source.mjs';

const sha = 'a'.repeat(40);
const branch = { commit: { sha } };
const run = {
  id: 123,
  head_sha: sha,
  head_branch: 'main',
  event: 'push',
  path: '.github/workflows/ci.yml',
  status: 'completed',
  conclusion: 'success',
};
const jobs = requiredChecks.map((name) => ({ name, status: 'completed', conclusion: 'success' }));

test('binds a candidate to current main and all five successful jobs in its push CI', () => {
  assert.equal(validateSource(sha, branch, [run], jobs).ciRunId, 123);
  assert.throws(() => validateSource('b'.repeat(40), branch, [run], jobs));
  for (const change of [
    { event: 'pull_request' },
    { path: '.github/workflows/other.yml' },
    { head_sha: 'b'.repeat(40) },
    { conclusion: 'failure' },
    { status: 'in_progress' },
  ])
    assert.throws(() => validateSource(sha, branch, [{ ...run, ...change }], jobs));
});

test('refuses missing, skipped, duplicate and unsuccessful architecture evidence', () => {
  assert.throws(() => validateSource(sha, branch, [], jobs));
  assert.throws(() => validateSource(sha, branch, [run], jobs.slice(1)));
  assert.throws(() => validateSource(sha, branch, [run], [...jobs.slice(1), jobs[1]]));
  for (const conclusion of ['skipped', 'failure', null])
    assert.throws(() =>
      validateSource(
        sha,
        branch,
        [run],
        jobs.map((job) => (job.name === 'application-arm64-check' ? { ...job, conclusion } : job)),
      ),
    );
});
