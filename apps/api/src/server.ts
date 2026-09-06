import { createDatabase } from '@stakeframe/db';
import { createApp } from './app.js';
import { readConfig } from './config.js';

async function main() {
  const config = readConfig(process.env);
  const database = createDatabase(config.databaseUrl);
  const app = createApp({ checkDatabase: database.check, logger: true });
  app.addHook('onClose', database.close);
  const stop = () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch {
    await app.close();
    throw new Error('API_START_FAILED');
  }
}

void main().catch(() => {
  console.error('API_START_FAILED: verify local configuration');
  process.exitCode = 1;
});
