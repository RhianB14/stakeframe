import { z } from 'zod';
import { requireDatabaseUrl, readRuntime, readDatabaseConfig } from '@stakeframe/db';
import { readAuthConfig } from './auth-config.js';

const environmentSchema = z.object({
  API_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export function readConfig(environment: NodeJS.ProcessEnv) {
  const runtime = readRuntime(environment);
  const result = environmentSchema.safeParse(environment);
  if (!result.success) throw new Error('INVALID_API_CONFIGURATION');
  return {
    runtime,
    host: result.data.API_HOST,
    port: result.data.API_PORT,
    databaseUrl: requireDatabaseUrl(readDatabaseConfig(environment)),
    auth: readAuthConfig(environment),
  };
}
