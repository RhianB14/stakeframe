import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { releaseInfoSchema, resolveReleaseInfo } from '../../packages/shared/src/index.js';

const commit = '274944f53f1fc418198bd256049644a38417ac24';

describe('release metadata', () => {
  it('resolves a fully stamped environment and normalizes the commit', () => {
    expect(
      resolveReleaseInfo({
        STAKEFRAME_VERSION: '0.1.0-beta.1',
        STAKEFRAME_COMMIT: commit.toUpperCase(),
        STAKEFRAME_BUILD_DATE: '2026-09-14T12:00:00Z',
        STAKEFRAME_RUNTIME: 'production',
      }),
    ).toEqual({
      version: '0.1.0-beta.1',
      commit,
      builtAt: '2026-09-14T12:00:00Z',
      environment: 'production',
    });
  });

  it('degrades missing or invalid values to explicit markers instead of guessing', () => {
    const markers = {
      version: 'unversioned',
      commit: 'unknown',
      builtAt: 'unknown',
      environment: 'unknown',
    };
    expect(resolveReleaseInfo({})).toEqual(markers);
    expect(
      resolveReleaseInfo({
        STAKEFRAME_VERSION: '1.0',
        STAKEFRAME_COMMIT: 'not-a-commit',
        STAKEFRAME_BUILD_DATE: 'hoje',
        STAKEFRAME_RUNTIME: 'staging',
      }),
    ).toEqual(markers);
    expect(resolveReleaseInfo({ STAKEFRAME_RUNTIME: 'local' }).environment).toBe('local');
  });

  it('keeps the repository version as the single source of truth for releases', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(
      releaseInfoSchema.safeParse({
        version: manifest.version,
        commit: 'unknown',
        builtAt: 'unknown',
        environment: 'unknown',
      }).success,
    ).toBe(true);
  });
});
