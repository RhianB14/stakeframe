import { createDatabase } from '@stakeframe/db';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createOwnerAuth } from './auth.js';

async function main() {
  const config = readConfig(process.env);
  const database = createDatabase(config.databaseUrl);
  const ownerAuth = config.auth.enabled ? createOwnerAuth(config.auth, database) : undefined;
  const app = createApp({
    checkDatabase: database.check,
    logger: true,
    runtime: config.runtime,
    ...(ownerAuth ? { ownerAuth } : {}),
  });
  app.addHook('onClose', database.close);
  const stop = () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    if (ownerAuth) await ownerAuth.auth.$context;
    await app.listen({ host: config.host, port: config.port });
  } catch {
    await app.close();
    throw new Error('API_START_FAILED');
  }
}

void main().catch(() => {
  console.error('API_START_FAILED: verify runtime configuration');
  process.exitCode = 1;
});
