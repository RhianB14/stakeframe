import { spawnSync } from 'node:child_process';

const password = process.env.LOCAL_DB_PASSWORD;
const port = process.env.LOCAL_DB_PORT ?? '55432';
if (
  !password ||
  !/^[a-f0-9]{48}$/.test(password) ||
  !/^\d+$/.test(port) ||
  Number(port) < 1 ||
  Number(port) > 65535
) {
  console.error('Invalid local test configuration. Use pnpm local:init.');
  process.exitCode = 1;
} else {
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.integration.config.ts',
      ...process.argv.slice(2),
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        TEST_DATABASE_URL: `postgresql://stakeframe_local:${password}@127.0.0.1:${port}/stakeframe_local`,
      },
    },
  );
  process.exitCode = result.status ?? 1;
}
