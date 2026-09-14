import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_REPOSITORY_PREFIX } from './traceability.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const pinFile = (entries) =>
  Object.entries(entries)
    .map(
      ([service, character]) =>
        `${service.toUpperCase()}_IMAGE=${DEFAULT_REPOSITORY_PREFIX}-${service}@${digest(character)}`,
    )
    .join('\n') + '\n';
const fullSet = { api: '1', worker: '2', migrate: '3', web: '4', operations: '5' };

function runPlan(directory, currentText, previousText, extra = []) {
  const current = join(directory, 'deployment.env');
  const previous = join(directory, 'deployment.previous.env');
  writeFileSync(current, currentText);
  writeFileSync(previous, previousText);
  return execFileSync(
    process.execPath,
    [
      'scripts/deployment/rollback-plan.mjs',
      '--current',
      current,
      '--previous',
      previous,
      ...extra,
    ],
    { encoding: 'utf8', windowsHide: true, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

test('prints a digest-only rollback plan for changed services', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stk-rollback-'));
  try {
    const output = runPlan(directory, pinFile({ ...fullSet, api: 'a' }), pinFile(fullSet));
    assert.match(output, /ROLLBACK_STEP api .*->.*/);
    assert.match(output, /ROLLBACK_UNCHANGED worker/);
    assert.match(output, /up -d --no-deps api/);
    assert.match(output, /ROLLBACK_MIGRATION_CHECK_REQUIRED/);
    assert.match(output, /ROLLBACK_PLAN_READY changed=1/);
    const clean = runPlan(directory, pinFile(fullSet), pinFile(fullSet));
    assert.match(clean, /ROLLBACK_PLAN_READY changed=0/);
    assert.doesNotMatch(clean, /ROLLBACK_COMMANDS/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('refuses a plan whose previous set cannot cover the current services', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stk-rollback-'));
  try {
    assert.throws(
      () => runPlan(directory, pinFile(fullSet), pinFile({ api: '1' })),
      (error) =>
        error.status === 1 &&
        /ROLLBACK_PLAN_REFUSED ROLLBACK_TARGET_MISSING worker/.test(error.stderr),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts boolean flags before value flags without swallowing them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stk-rollback-'));
  try {
    const output = runPlan(directory, pinFile(fullSet), pinFile(fullSet), [
      '--check',
      '--repository-prefix',
      DEFAULT_REPOSITORY_PREFIX,
    ]);
    assert.match(output, /ROLLBACK_PLAN_READY changed=0/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
