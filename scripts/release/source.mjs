import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const requiredChecks = [
  'format-check',
  'application-check',
  'application-arm64-check',
  'network-security-simulation',
  'recovery-check',
];

export function validateSource(sha, branch, runs, jobs) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(branch.commit.sha, sha, 'RELEASE_CURRENT_MAIN_REQUIRED');
  assert.equal(runs.length, 1, 'RELEASE_CI_RUN_REQUIRED');
  const run = runs[0];
  assert.equal(run.head_sha, sha);
  assert.equal(run.head_branch, 'main');
  assert.equal(run.event, 'push');
  assert.equal(run.path, '.github/workflows/ci.yml');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(jobs.length, requiredChecks.length);
  assert.deepEqual(jobs.map((job) => job.name).sort(), [...requiredChecks].sort());
  assert.ok(jobs.every((job) => job.status === 'completed' && job.conclusion === 'success'));
  return { version: 1, sourceSha: sha, ciRunId: run.id, checks: requiredChecks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const sha = process.env.SOURCE_SHA;
  assert.match(sha ?? '', /^[a-f0-9]{40}$/);
  assert.equal(process.env.GITHUB_REPOSITORY, 'RhianB14/stakeframe');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  assert.equal(process.env.GITHUB_SHA, sha);
  const api = async (path) => {
    const response = await fetch(`https://api.github.com/repos/RhianB14/stakeframe/${path}`, {
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(response.ok, 'RELEASE_GITHUB_READ_FAILED');
    return response.json();
  };
  const [branch, result] = await Promise.all([
    api('branches/main'),
    api(`actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=1`),
  ]);
  const runs = result.workflow_runs;
  assert.equal(runs.length, 1);
  const jobs = await api(`actions/runs/${runs[0].id}/jobs?filter=latest&per_page=100`);
  const report = validateSource(sha, branch, runs, jobs.jobs);
  await mkdir('.cache/release', { recursive: true });
  await writeFile('.cache/release/source-validation.json', JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  console.info(`RELEASE_SOURCE_VERIFIED ${sha}`);
}
