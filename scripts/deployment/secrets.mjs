import { lstat } from 'node:fs/promises';

export const POSIX_GROUP_OTHER_BITS = 0o077;

// A secret directory must not expose names or metadata to group or other
// users. The check applies to POSIX only: Windows does not enforce POSIX mode
// bits, and protection there comes from the private ACLs prepared by the
// deployment rehearsal.
export function assertSecretDirectoryPlatform(mode, platform) {
  if (platform === 'win32') return mode;
  if ((mode & POSIX_GROUP_OTHER_BITS) !== 0)
    throw new Error('SECRET_DIRECTORY_EXPOSED_' + (mode & POSIX_GROUP_OTHER_BITS).toString(8));
  return mode;
}

export async function inspectSecretDirectories(
  directories,
  { platform = process.platform, lstat: stat = lstat } = {},
) {
  const observations = new Map();
  for (const directory of directories) {
    // A repeated directory must not produce divergent behavior: verify each
    // distinct directory exactly once and keep the first observation.
    if (observations.has(directory)) continue;
    const info = await stat(directory);
    if (!info.isDirectory()) throw new Error('SECRET_DIRECTORY_NOT_A_DIRECTORY');
    observations.set(directory, assertSecretDirectoryPlatform(info.mode, platform));
  }
  return observations;
}
