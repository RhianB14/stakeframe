import { z } from 'zod';
import { requireDatabaseUrl, readRuntime, readDatabaseConfig } from '@stakeframe/db';
import { resolveReleaseInfo } from '@stakeframe/shared';
import { readAuthConfig } from './auth-config.js';
import { readTelemetryConfig } from './telemetry.js';

const environmentSchema = z.object({
  API_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // STK-F2-02: limiar de baixa amostra e TTL do cache do dashboard analítico.
  DASHBOARD_MIN_SAMPLE: z.coerce.number().int().min(1).max(100_000).default(30),
  DASHBOARD_CACHE_TTL_MS: z.coerce.number().int().min(0).max(600_000).default(30_000),
});

export function readConfig(environment: NodeJS.ProcessEnv) {
  const runtime = readRuntime(environment);
  const result = environmentSchema.safeParse(environment);
  if (!result.success) throw new Error('INVALID_API_CONFIGURATION');
  return {
    runtime,
    host: result.data.API_HOST,
    port: result.data.API_PORT,
    dashboard: {
      minSample: result.data.DASHBOARD_MIN_SAMPLE,
      cacheTtlMs: result.data.DASHBOARD_CACHE_TTL_MS,
    },
    databaseUrl: requireDatabaseUrl(readDatabaseConfig(environment)),
    auth: readAuthConfig(environment),
    release: resolveReleaseInfo(environment),
    telemetry: readTelemetryConfig(environment),
  };
}
