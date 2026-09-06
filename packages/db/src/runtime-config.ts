import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export function readRuntime(environment: NodeJS.ProcessEnv): 'local' | 'production' {
  const runtime = environment.STAKEFRAME_RUNTIME;
  if (
    (runtime !== 'local' && runtime !== 'production') ||
    (runtime === 'production' && environment.NODE_ENV !== 'production')
  )
    throw new Error('INVALID_RUNTIME_CONFIGURATION');
  return runtime;
}

// File-based secrets remain outside Docker's environment metadata. Never reflect input.
export function readSecret(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = environment[`${name}_FILE`];
  const value = environment[name];
  if (file !== undefined && value !== undefined) throw new Error('AMBIGUOUS_SECRET_CONFIGURATION');
  if (environment.STAKEFRAME_RUNTIME === 'production' && (!file || value !== undefined))
    throw new Error('SECRET_FILE_REQUIRED');
  if (file === undefined) return value;
  try {
    if (!isAbsolute(file)) throw new Error();
    const buffer = readFileSync(file);
    if (buffer.length > 4096) throw new Error();
    const secret = buffer.toString('utf8').replace(/\r?\n$/, '');
    if (!secret || /[\r\n\0]/.test(secret)) throw new Error();
    return secret;
  } catch {
    throw new Error('SECRET_FILE_INVALID');
  }
}

export function readDatabaseConfig(environment: NodeJS.ProcessEnv): string {
  if (readRuntime(environment) === 'local') return environment.DATABASE_URL ?? '';
  if (environment.DATABASE_URL !== undefined) throw new Error('PRODUCTION_DATABASE_URL_REFUSED');
  const password = readSecret(environment, 'DB_PASSWORD');
  if (!password || !/^[a-f0-9]{64}$/.test(password)) throw new Error('INVALID_DATABASE_SECRET');
  // Production Compose owns this private service name, database and non-superuser role.
  return `postgresql://stakeframe_app:${password}@postgres:5432/stakeframe`;
}
