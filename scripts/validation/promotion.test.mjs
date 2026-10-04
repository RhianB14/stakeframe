import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const base = new URL('../../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, base), 'utf8');

const promotionRunbook = read('docs/deploy/promotion-runbook.md');
const migrationRunbook = read('docs/deploy/migration-runbook.md');
const migrationCompose = read('compose.migration.yml');
const candidateImages = read('.github/workflows/release-candidate.yml');
const promotionRecord = read('.github/workflows/promotion-record.yml');
const ci = read('.github/workflows/ci.yml');

const SECRET =
  /ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9-]{24,}|BEGIN [A-Z ]+PRIVATE KEY/g;

const lineStarts = (content, token) => new RegExp(`^\\s*${token}`, 'm').test(content);

test('promotion runbook covers the manual window by digest', () => {
  for (const marker of [
    'sha256:',
    'deployment-check.mjs',
    'deployment-verify.mjs',
    'compose.production.yml',
    'compose.migration.yml',
    'migration-runbook.md',
    'ROLLBACK.md',
    'promotion-record.json',
    'Environment `production`',
    'Critérios de aborto',
  ]) {
    assert.ok(promotionRunbook.includes(marker), `promotion-runbook.md is missing: ${marker}`);
  }
});

test('migration runbook keeps migration separate, guarded and manual', () => {
  for (const marker of [
    'compose.migration.yml',
    'MIGRATION_CONFIRM=production',
    'Forward-only',
    'Sem retry',
    'drizzle.__drizzle_migrations',
    'RECOVERY.md',
    'run --rm -e MIGRATION_CONFIRM=production migrate',
  ]) {
    assert.ok(migrationRunbook.includes(marker), `migration-runbook.md is missing: ${marker}`);
  }
});

test('migration compose mirrors the production hardening and joins only the backend network', () => {
  for (const marker of [
    'read_only: true',
    'tmpfs: [/tmp]',
    'cap_drop: [ALL]',
    'no-new-privileges:true',
    'pids_limit: 128',
    'mem_limit: 512m',
    'cpus: 0.75',
    'io.stakeframe.deployment',
    'MIGRATE_IMAGE:?',
    'MIGRATION_CONFIRM',
    'DB_PASSWORD_FILE: /run/secrets/db_password',
    'external: true',
    'stakeframe-production_backend',
    '${SECRET_DIRECTORY:?',
    '${DEPLOYMENT_ID:?',
  ]) {
    assert.ok(migrationCompose.includes(marker), `compose.migration.yml is missing: ${marker}`);
  }
  assert.ok(!migrationCompose.includes(':latest'), 'compose.migration.yml must never use latest');
});

test('release candidate workflow builds the five targets for review without any production access', () => {
  for (const marker of [
    'workflow_dispatch',
    'source_sha',
    'scripts/release/source.mjs',
    'verify_oci.py',
    'candidate-${{ inputs.source_sha }}-${{ matrix.arch }}',
    'for target in api worker migrate web-production operations',
  ]) {
    assert.ok(candidateImages.includes(marker), `release-candidate.yml is missing: ${marker}`);
  }
  assert.ok(
    !lineStarts(candidateImages, 'environment'),
    'candidate build must not use a production environment gate',
  );
  for (const forbidden of ['ssh', 'secrets', 'PRIVATE KEY']) {
    assert.ok(
      !lineStarts(candidateImages, forbidden),
      `release-candidate.yml must not contain: ${forbidden}`,
    );
  }
  assert.ok(!candidateImages.includes(':latest'), 'release-candidate.yml must never use latest');
});

test('promotion record workflow is the approval gate and never deploys', () => {
  for (const marker of [
    'workflow_dispatch',
    'candidate_run_id',
    'deployment_id',
    'environment: production',
    'actions/runs/',
    'scripts/release/promotion_record.py',
    'promotion-record.json',
  ]) {
    assert.ok(promotionRecord.includes(marker), `promotion-record.yml is missing: ${marker}`);
  }
  for (const forbidden of ['ssh', 'secrets', 'packages', 'PRIVATE KEY']) {
    assert.ok(
      !lineStarts(promotionRecord, forbidden),
      `promotion-record.yml must not contain: ${forbidden}`,
    );
  }
  assert.ok(!promotionRecord.includes(':latest'), 'promotion-record.yml must never use latest');
});

test('promotion record workflow points the evidence flag at the download directory', () => {
  assert.ok(
    promotionRecord.includes('--evidence .cache/promotion/evidence'),
    'promotion-record.yml must pass the evidence directory',
  );
  assert.ok(
    !promotionRecord.includes('--evidence-amd64') && !promotionRecord.includes('--evidence-arm64'),
    'promotion-record.yml must not compose per-architecture evidence: only arm64 is published',
  );
  assert.ok(
    !promotionRecord.includes('--evidence .cache/promotion/evidence/candidate.json'),
    'promotion-record.yml must not pass a file path where the script expects a directory',
  );
});

test('promotion record composes the two halves of the evidence it never sees together', () => {
  // The candidate archive carries candidate.json and the publication archive
  // carries published.json; the record is the only place they meet.
  for (const marker of [
    'publication_run_id',
    'candidate-$SOURCE_SHA-arm64',
    'publication-$PUBLICATION_RUN_ID',
    'approved-arm64.json',
  ]) {
    assert.ok(promotionRecord.includes(marker), `promotion-record.yml is missing: ${marker}`);
  }
});

test('continuous integration runs the promotion composition checks', () => {
  assert.ok(ci.includes('promotion-check'), 'ci.yml must define the promotion-check job');
  assert.ok(
    ci.includes('scripts/validation/promotion.test.mjs'),
    'ci.yml must run promotion.test.mjs',
  );
  assert.ok(
    ci.includes('docker compose -f compose.production.yml config'),
    'ci.yml must validate compose.production.yml',
  );
  assert.ok(
    ci.includes('docker compose -f compose.migration.yml config'),
    'ci.yml must validate compose.migration.yml',
  );
});

test('promotion artifacts carry no secret material', () => {
  const files = {
    'docs/deploy/promotion-runbook.md': promotionRunbook,
    'docs/deploy/migration-runbook.md': migrationRunbook,
    'compose.migration.yml': migrationCompose,
    '.github/workflows/release-candidate.yml': candidateImages,
    '.github/workflows/promotion-record.yml': promotionRecord,
    'scripts/release/registry_publish.py': read('scripts/release/registry_publish.py'),
    'scripts/release/promotion_record.py': read('scripts/release/promotion_record.py'),
  };
  for (const [name, content] of Object.entries(files)) {
    const matches = content.match(SECRET) ?? [];
    assert.deepEqual(matches, [], `${name} contains secret-like material`);
  }
});
