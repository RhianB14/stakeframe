import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/auth-schema.ts', './src/inbox-schema.ts', './src/finance-schema.ts'],
  out: './migrations',
  strict: true,
});
