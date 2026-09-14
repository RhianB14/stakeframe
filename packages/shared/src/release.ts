import { z } from 'zod';

/**
 * Release metadata baked into the running artifact. The single source of truth for the
 * application version is the root `package.json` `version` field; build systems copy it
 * into `STAKEFRAME_VERSION` (Docker build argument, CI workflow) and the remaining values
 * come from the build itself. Every field degrades to an explicit marker instead of a
 * guess: `unversioned` / `unknown`. Nothing here is secret: version, commit, build date
 * and environment are operational identifiers only.
 */
export const releaseInfoSchema = z
  .object({
    version: z.union([
      z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
      z.literal('unversioned'),
    ]),
    commit: z.union([z.string().regex(/^[0-9a-f]{7,40}$/), z.literal('unknown')]),
    builtAt: z.union([
      z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      z.literal('unknown'),
    ]),
    environment: z.enum(['local', 'production', 'unknown']),
  })
  .meta({ id: 'ReleaseInfo' });

export type ReleaseInfo = z.infer<typeof releaseInfoSchema>;

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const commitPattern = /^[0-9a-f]{7,40}$/;
const builtAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Resolves the release metadata from the environment. Values that are absent or invalid
 * degrade to the explicit markers above so the response contract stays stable and the
 * owner panel can hide what was never stamped, instead of showing invented data.
 */
export function resolveReleaseInfo(
  environment: Record<string, string | undefined> = {},
): ReleaseInfo {
  const version = environment.STAKEFRAME_VERSION?.trim();
  const commit = environment.STAKEFRAME_COMMIT?.trim().toLowerCase();
  const builtAt = environment.STAKEFRAME_BUILD_DATE?.trim();
  const runtime = environment.STAKEFRAME_RUNTIME?.trim();
  return releaseInfoSchema.parse({
    version: version && versionPattern.test(version) ? version : 'unversioned',
    commit: commit && commitPattern.test(commit) ? commit : 'unknown',
    builtAt: builtAt && builtAtPattern.test(builtAt) ? builtAt : 'unknown',
    environment:
      runtime === 'production' ? 'production' : runtime === 'local' ? 'local' : 'unknown',
  });
}
