import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { google, verifyGoogleIdToken } from 'better-auth/social-providers';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { and, eq } from 'drizzle-orm';
import { authSchema, type Database } from '@stakeframe/db';
import type { EnabledAuthConfig } from './auth-config.js';

export function isAllowedGoogleProfile(
  profile: Record<string, unknown> | undefined,
  config: EnabledAuthConfig,
) {
  return (
    profile?.sub === config.ownerSubject &&
    profile.email_verified === true &&
    typeof profile.email === 'string' &&
    profile.email.toLowerCase() === config.ownerEmail
  );
}

export function createOwnerAuth(config: EnabledAuthConfig, database: Database) {
  const googleProvider = google({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
  });
  async function isOwner(userId: string) {
    const rows = await database.orm
      .select({ id: authSchema.user.id })
      .from(authSchema.user)
      .innerJoin(authSchema.account, eq(authSchema.account.userId, authSchema.user.id))
      .where(
        and(
          eq(authSchema.user.id, userId),
          eq(authSchema.user.email, config.ownerEmail),
          eq(authSchema.user.emailVerified, true),
          eq(authSchema.account.providerId, 'google'),
          eq(authSchema.account.accountId, config.ownerSubject),
        ),
      )
      .limit(1);
    return rows.length === 1;
  }
  const discardProviderTokens = {
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };
  const auth = betterAuth({
    appName: 'Stakeframe',
    baseURL: config.origin,
    basePath: '/api/auth',
    secret: config.secret,
    database: drizzleAdapter(database.orm, {
      provider: 'pg',
      schema: authSchema,
      transaction: true,
    }),
    trustedOrigins: [config.origin],
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        disableIdTokenSignIn: true,
        prompt: 'select_account',
        accessType: 'online',
        getUserInfo: async (tokens) => {
          if (!tokens.idToken) return null;
          const verified = await verifyGoogleIdToken({
            token: tokens.idToken,
            audience: config.googleClientId,
          });
          if (
            !verified ||
            typeof verified.exp !== 'number' ||
            (verified.azp !== undefined && verified.azp !== config.googleClientId) ||
            !isAllowedGoogleProfile(verified, config)
          )
            return null;
          return googleProvider.getUserInfo(tokens);
        },
      },
    },
    user: {
      validateUserInfo: ({ user, source }) => {
        if (
          source.method !== 'oauth' ||
          source.oauth?.providerId !== 'google' ||
          !isAllowedGoogleProfile(source.oauth.profile, config) ||
          user.emailVerified !== true ||
          user.email?.toLowerCase() !== config.ownerEmail
        )
          return { error: 'access_denied', errorDescription: 'Access denied' };
      },
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    session: { expiresIn: 43_200, cookieCache: { enabled: false }, disableSessionRefresh: true },
    account: {
      accountLinking: { enabled: false },
      storeStateStrategy: 'database',
      storeAccountCookie: false,
      encryptOAuthTokens: true,
    },
    advanced: {
      useSecureCookies: config.origin.startsWith('https:'),
      cookiePrefix: 'stakeframe',
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      trustedProxyHeaders: false,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      storage: 'memory',
      customRules: {
        '/sign-in/social': { window: 60, max: 5 },
        '/callback/google': { window: 60, max: 20 },
      },
    },
    databaseHooks: {
      account: {
        create: {
          before: async (account) => {
            if (account.providerId !== 'google' || account.accountId !== config.ownerSubject)
              throw new APIError('FORBIDDEN', { message: 'Access denied' });
            return { data: { ...account, ...discardProviderTokens } };
          },
        },
        update: { before: async (account) => ({ data: { ...account, ...discardProviderTokens } }) },
      },
      session: {
        create: {
          before: async (session) => {
            if (!(await isOwner(session.userId)))
              throw new APIError('FORBIDDEN', { message: 'Access denied' });
            return { data: session };
          },
        },
      },
    },
    onAPIError: { errorURL: `${config.origin}/?auth=failed` },
    logger: { disabled: true },
    telemetry: { enabled: false },
  });
  return {
    auth,
    origin: config.origin,
    async getOwner(headers: Headers) {
      const session = await auth.api.getSession({
        headers,
        query: { disableCookieCache: true, disableRefresh: true },
      });
      if (!session || !(await isOwner(session.user.id))) return null;
      return {
        user: { id: session.user.id, name: session.user.name },
        expiresAt: session.session.expiresAt.toISOString(),
      };
    },
  };
}
export type OwnerAuth = ReturnType<typeof createOwnerAuth>;
