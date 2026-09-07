import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const approval = JSON.parse(await readFile('infra/release/approved-arm64.json', 'utf8'));
assert.equal(process.env.GITHUB_REPOSITORY, 'RhianB14/stakeframe');
assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
const api = async (path) => {
  const response = await fetch(`https://api.github.com/repos/RhianB14/stakeframe/${path}`, {
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(120000),
  });
  assert.ok(response.ok, 'PUBLICATION_GITHUB_READ_FAILED');
  return response;
};
const run = await (await api(`actions/runs/${approval.candidateRunId}`)).json();
assert.equal(run.head_sha, approval.sourceSha);
assert.equal(run.head_branch, 'main');
assert.equal(run.event, 'workflow_dispatch');
assert.equal(run.path, '.github/workflows/release-candidate.yml');
assert.equal(run.status, 'completed');
assert.equal(run.conclusion, 'success');
const { jobs } = await (await api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).json();
assert.deepEqual(jobs.map((job) => job.name).sort(), ['candidate-amd64', 'candidate-arm64']);
assert.ok(jobs.every((job) => job.status === 'completed' && job.conclusion === 'success'));
const artifact = await (await api(`actions/artifacts/${approval.artifact.id}`)).json();
assert.equal(artifact.workflow_run.id, run.id);
assert.equal(artifact.workflow_run.head_sha, approval.sourceSha);
assert.equal(artifact.name, approval.artifact.name);
assert.equal(artifact.size_in_bytes, approval.artifact.bytes);
assert.equal(artifact.digest, `sha256:${approval.artifact.sha256}`);
assert.equal(artifact.expired, false);
await mkdir('.cache/publication', { recursive: true });
// Fetch strips Authorization on the cross-origin redirect to artifact storage.
const response = await api(`actions/artifacts/${artifact.id}/zip`);
let bytes = 0;
await pipeline(
  Readable.fromWeb(response.body),
  new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > approval.artifact.bytes ? new Error('PUBLICATION_SIZE_EXCEEDED') : null,
        chunk,
      );
    },
  }),
  createWriteStream('.cache/publication/approved.zip', { flags: 'wx' }),
);
assert.equal(bytes, approval.artifact.bytes);
console.info(`PUBLICATION_ARTIFACT_DOWNLOADED ${artifact.id}`);
