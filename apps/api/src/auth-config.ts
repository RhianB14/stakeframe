import { z } from 'zod';

const enabledSchema = z.object({
  APP_ORIGIN: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  AUTHORIZED_GOOGLE_EMAIL: z.email().transform((email) => email.toLowerCase()),
  AUTHORIZED_GOOGLE_SUB: z.string().min(1).max(255).regex(/^\S+$/),
});
export type EnabledAuthConfig = {
  enabled: true;
  origin: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
  ownerEmail: string;
  ownerSubject: string;
};
export type AuthConfig = EnabledAuthConfig | { enabled: false };

export function readAuthConfig(environment: NodeJS.ProcessEnv): AuthConfig {
  if (environment.AUTH_ENABLED === undefined || environment.AUTH_ENABLED === 'false')
    return { enabled: false };
  const result = enabledSchema.safeParse(environment);
  if (environment.AUTH_ENABLED !== 'true' || !result.success)
    throw new Error('INVALID_AUTH_CONFIGURATION');
  const url = new URL(result.data.APP_ORIGIN);
  const localHttp =
    url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    (!localHttp && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('INVALID_AUTH_ORIGIN');
  return {
    enabled: true,
    origin: url.origin,
    secret: result.data.BETTER_AUTH_SECRET,
    googleClientId: result.data.GOOGLE_CLIENT_ID,
    googleClientSecret: result.data.GOOGLE_CLIENT_SECRET,
    ownerEmail: result.data.AUTHORIZED_GOOGLE_EMAIL,
    ownerSubject: result.data.AUTHORIZED_GOOGLE_SUB,
  };
}
