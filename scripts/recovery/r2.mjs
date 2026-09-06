import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

const endpointPattern = /^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/;
const projectPattern = /^stk-recovery-[a-f0-9]{32}$/;
export const r2Bucket = 'stakeframe-backups';

export function r2Repository(endpoint, project) {
  if (!endpointPattern.test(endpoint)) throw new Error('RECOVERY_R2_ENDPOINT_REFUSED');
  if (!projectPattern.test(project)) throw new Error('RECOVERY_PROJECT_REFUSED');
  return `s3:${endpoint}/${r2Bucket}/m0-rehearsals/${project}`;
}

async function readPrivateFile(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 4096)
      throw new Error('INVALID');
    return (await readFile(path, 'utf8')).replace(/\r?\n$/, '');
  } catch {
    throw new Error('RECOVERY_R2_PRIVATE_FILE_REFUSED');
  }
}

export async function loadR2Configuration(directory, workspace) {
  try {
    if (!isAbsolute(directory) || !(await lstat(directory)).isDirectory())
      throw new Error('INVALID');
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('INVALID');
    const actual = await realpath(directory);
    const fromWorkspace = relative(await realpath(workspace), actual);
    if (
      fromWorkspace === '' ||
      (!isAbsolute(fromWorkspace) &&
        fromWorkspace !== '..' &&
        !fromWorkspace.startsWith(`..${sep}`))
    )
      throw new Error('INVALID');
    if (process.platform !== 'win32' && ((await lstat(actual)).mode & 0o077) !== 0)
      throw new Error('INVALID');
    const endpoint = await readPrivateFile(join(actual, 'endpoint'));
    r2Repository(endpoint, `stk-recovery-${'0'.repeat(32)}`);
    // Validate without putting secret values in the returned config or process arguments.
    if (!/^[a-f0-9]{32}$/.test(await readPrivateFile(join(actual, 'access_key_id'))))
      throw new Error('INVALID');
    if (!/^[a-f0-9]{64}$/.test(await readPrivateFile(join(actual, 'secret_access_key'))))
      throw new Error('INVALID');
    return { directory: actual, endpoint };
  } catch {
    throw new Error('RECOVERY_R2_CONFIGURATION_REFUSED');
  }
}

export async function retainR2RecoveryKey(config, project, runDirectory) {
  const repository = r2Repository(config.endpoint, project);
  const parent = join(config.directory, 'rehearsals');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await lstat(parent)).isSymbolicLink() || (await realpath(parent)) !== parent)
    throw new Error('RECOVERY_R2_ARCHIVE_REFUSED');
  const archive = join(parent, project);
  await mkdir(archive, { mode: 0o700 });
  // Keep the recovery key before the first upload. Local cleanup must never make
  // a retained remote test snapshot unreadable by deleting its only key.
  await writeFile(
    join(archive, 'repository_password'),
    await readFile(join(runDirectory, 'repository_password')),
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(
    join(archive, 'repository.json'),
    `${JSON.stringify({ repository, project, fictitiousDataOnly: true }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return archive;
}
