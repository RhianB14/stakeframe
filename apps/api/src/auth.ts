import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { google, verifyGoogleIdToken } from 'better-auth/social-providers';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { runWithTransaction } from '@better-auth/core/context';
import { and, eq } from 'drizzle-orm';
import {
  authSchema,
  captureTransactions,
  createBetaInvitation,
  createTenantContext,
  currentTransaction,
  normalizeInvitationEmail,
  type Database,
} from '@stakeframe/db';
import type { EnabledAuthConfig } from './auth-config.js';
import type { BetaEmailTransport } from './beta-email.js';

export const BETA_INVITE_COOKIE = 'stakeframe-invite';
export const BETA_INVITE_COOKIE_MAX_AGE_SECONDS = 3600;

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

export function createOwnerAuth(
  config: EnabledAuthConfig,
  database: Database,
  options: { emailTransport?: BetaEmailTransport } = {},
) {
  const tenant = createTenantContext(database);
  const invitations = createBetaInvitation(database);
  const emailTransport = options.emailTransport;
  const emailPasswordEnabled = Boolean(emailTransport);
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
  function accessDenied() {
    // The stable code lets the library turn the refusal into the generic failure
    // redirect (?auth=failed); the message never carries internal detail.
    return new APIError('FORBIDDEN', { message: 'Access denied', code: 'ACCESS_DENIED' });
  }
  /**
   * Identity lookup for the beta gate. Prefers the Better Auth internal adapter so a user
   * created earlier in the same request transaction stays visible; falls back to the pool.
   */
  async function loadIdentity(
    ctx: unknown,
    userId: unknown,
  ): Promise<{ email: string; emailVerified: boolean } | null> {
    if (typeof userId !== 'string' || userId.length === 0) return null;
    const adapter = (
      ctx as { context?: { internalAdapter?: { findUserById?: unknown } } } | null | undefined
    )?.context?.internalAdapter;
    const findUserById = (
      adapter as { findUserById?: (id: string) => Promise<unknown> } | undefined
    )?.findUserById;
    if (typeof findUserById === 'function') {
      try {
        const raw = (await findUserById.call(adapter, userId)) as
          { email?: unknown; emailVerified?: unknown } | null | undefined;
        if (typeof raw?.email === 'string' && raw.email.length > 0) {
          return { email: raw.email, emailVerified: raw.emailVerified === true };
        }
      } catch {
        // Fall through to the pool below.
      }
    }
    try {
      const rows = await database.orm
        .select({ email: authSchema.user.email, emailVerified: authSchema.user.emailVerified })
        .from(authSchema.user)
        .where(eq(authSchema.user.id, userId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return { email: row.email, emailVerified: row.emailVerified === true };
    } catch {
      return null;
    }
  }
  function inviteTokenFromContext(ctx: unknown): string | undefined {
    try {
      const getCookie = (ctx as { getCookie?: (name: string) => string | null } | null | undefined)
        ?.getCookie;
      if (typeof getCookie !== 'function') return undefined;
      const token = getCookie.call(ctx, BETA_INVITE_COOKIE);
      if (typeof token !== 'string' || token.length === 0 || token.length > 512) return undefined;
      return token;
    } catch {
      return undefined;
    }
  }
  /** Admission rule for a new identity: an acceptable invitation bound to this e-mail. */
  async function assertBetaInvitationFor(email: string, ctx: unknown): Promise<void> {
    const token = inviteTokenFromContext(ctx);
    if (!token) throw accessDenied();
    try {
      await invitations.assertInvitationAcceptableForEmail(token, email);
    } catch {
      throw accessDenied();
    }
  }
  /** True when the current request is an e-mail/password body carrying this same e-mail. */
  function isEmailPasswordBody(ctx: unknown, email: string): boolean {
    const body = (ctx as { body?: { email?: unknown } } | null | undefined)?.body;
    return typeof body?.email === 'string' && body.email.trim().toLowerCase() === email;
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
    database: drizzleAdapter(captureTransactions(database.orm), {
      provider: 'pg',
      schema: authSchema,
      transaction: true,
    }),
    trustedOrigins: [config.origin],
    emailAndPassword: emailPasswordEnabled
      ? {
          enabled: true,
          requireEmailVerification: true,
          autoSignIn: false,
          minPasswordLength: 8,
          maxPasswordLength: 128,
        }
      : { enabled: false },
    ...(emailPasswordEnabled
      ? {
          emailVerification: {
            sendOnSignUp: true,
            autoSignInAfterVerification: false,
            expiresIn: 3_600,
            sendVerificationEmail: async ({
              user,
              url,
              token,
            }: {
              user: { email: string };
              url: string;
              token: string;
            }) => {
              // Controlled fake transport: no real e-mail is ever sent in local/CI.
              await emailTransport!.sendVerificationEmail({ to: user.email, url, token });
            },
          },
        }
      : {}),
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
            (verified.azp !== undefined && verified.azp !== config.googleClientId)
          )
            return null;
          if (isAllowedGoogleProfile(verified, config)) return googleProvider.getUserInfo(tokens);
          // Beta candidate: a cryptographically verified e-mail that is not the owner's.
          // Admission is enforced by the database hooks (invitation bound to this e-mail).
          if (
            verified.email_verified === true &&
            typeof verified.email === 'string' &&
            verified.email.toLowerCase() !== config.ownerEmail
          )
            return googleProvider.getUserInfo(tokens);
          return null;
        },
      },
    },
    user: {
      validateUserInfo: ({ user, source }) => {
        if (source.method === 'oauth') {
          if (source.oauth?.providerId !== 'google') {
            return { error: 'access_denied', errorDescription: 'Access denied' };
          }
          const profile = source.oauth.profile;
          if (
            isAllowedGoogleProfile(profile, config) &&
            user.emailVerified === true &&
            user.email?.toLowerCase() === config.ownerEmail
          )
            return;
          // Beta candidate: verified Google e-mail, never the owner's; the invitation gate
          // runs in the database hooks before any identity is persisted.
          if (
            profile?.email_verified === true &&
            typeof profile.email === 'string' &&
            profile.email.toLowerCase() !== config.ownerEmail &&
            user.emailVerified === true &&
            typeof user.email === 'string' &&
            user.email.toLowerCase() === profile.email.toLowerCase()
          )
            return;
          return { error: 'access_denied', errorDescription: 'Access denied' };
        }
        if (source.method === 'email-password') {
          // Beta e-mail/password admission is enforced by the database hooks below
          // (invitation bound to the e-mail); never for the owner e-mail.
          return;
        }
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
        '/sign-up/email': { window: 60, max: 5 },
        '/sign-in/email': { window: 60, max: 5 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            let email: string;
            try {
              email = normalizeInvitationEmail(
                typeof user.email === 'string' ? user.email : (undefined as unknown as string),
              );
            } catch {
              throw accessDenied();
            }
            if (email === config.ownerEmail) {
              // The owner identity is admitted only through the owner OAuth path
              // (validated upstream); no password account may exist for it.
              if (isEmailPasswordBody(ctx, email)) throw accessDenied();
              return;
            }
            await assertBetaInvitationFor(email, ctx);
          },
        },
      },
      account: {
        create: {
          before: async (account, ctx) => {
            if (account.providerId === 'google' && account.accountId === config.ownerSubject) {
              return { data: { ...account, ...discardProviderTokens } };
            }
            const identity = await loadIdentity(ctx, account.userId);
            if (!identity || identity.email === config.ownerEmail) throw accessDenied();
            if (account.providerId === 'google') {
              if (identity.emailVerified !== true) throw accessDenied();
              await assertBetaInvitationFor(identity.email, ctx);
              return { data: { ...account, ...discardProviderTokens } };
            }
            if (account.providerId === 'credential') {
              const token = inviteTokenFromContext(ctx);
              if (!token) throw accessDenied();
              const transaction = currentTransaction();
              if (!transaction) throw accessDenied();
              // Consumption runs on the sign-up transaction itself: a later failure rolls the
              // acceptance back together with the identity that justified it.
              await invitations.consumeInvitationForUser(transaction, token, {
                userId: account.userId,
                email: identity.email,
              });
              return { data: account };
            }
            throw accessDenied();
          },
        },
        update: { before: async (account) => ({ data: { ...account, ...discardProviderTokens } }) },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            if (await isOwner(session.userId)) return { data: session };
            const identity = await loadIdentity(ctx, session.userId);
            if (
              !identity ||
              identity.email === config.ownerEmail ||
              identity.emailVerified !== true
            )
              throw accessDenied();
            if (await invitations.findAcceptedInvitationForUser(session.userId))
              return { data: session };
            const token = inviteTokenFromContext(ctx);
            if (!token) throw accessDenied();
            const transaction = currentTransaction();
            if (!transaction) throw accessDenied();
            try {
              // Single-use consumption on the SAME transaction as the session insert: a
              // failure after this point rolls the acceptance back with the rest of the flow,
              // so an accepted invitation never survives without its session.
              await invitations.consumeInvitationForUser(transaction, token, {
                userId: session.userId,
                email: identity.email,
              });
            } catch {
              throw accessDenied();
            }
            return { data: session };
          },
        },
      },
    },
    onAPIError: { errorURL: `${config.origin}/?auth=failed` },
    logger: { disabled: true },
    telemetry: { enabled: false },
  });
  // The library resets its transaction state at the HTTP handler boundary, so the atomic
  // unit is the session creation itself: the session write — database hooks included — runs
  // inside ONE transaction. Any failure in that unit (invitation consumption or the session
  // insert) rolls the whole unit back, so an accepted invitation never survives without its
  // session. The invitation consumption inside the hook runs on this same transaction via
  // `currentTransaction()` (captured by `captureTransactions` on the Drizzle instance).
  void auth.$context
    .then((context) => {
      const internal = context.internalAdapter as unknown as {
        createSession: (...args: unknown[]) => Promise<unknown>;
      };
      const original = internal.createSession;
      internal.createSession = (...args: unknown[]) =>
        runWithTransaction(context.adapter, () => original(...args));
    })
    .catch(() => undefined);
  return {
    auth,
    origin: config.origin,
    beta: {
      emailPasswordEnabled,
      readAcceptableInvitation: invitations.readAcceptableInvitation,
    },
    async getOwner(headers: Headers) {
      const session = await auth.api.getSession({
        headers,
        query: { disableCookieCache: true, disableRefresh: true },
      });
      if (!session) return null;
      if (!(await isOwner(session.user.id))) {
        // Beta user admitted by an accepted invitation (single organization per user).
        const admitted = await invitations.findAcceptedInvitationForUser(session.user.id);
        if (!admitted) return null;
      }
      try {
        await tenant.ensureOrganizationMembership(session.user.id);
        const organization = await tenant.resolveOrganizationContext(session.user.id);
        return {
          user: { id: session.user.id, name: session.user.name },
          organization: { id: organization.organizationId, role: organization.role },
          expiresAt: session.session.expiresAt.toISOString(),
        };
      } catch {
        // Sanitized fail-closed behavior: membership/organization failures behave exactly like
        // an unauthenticated session; no database detail ever reaches the caller.
        return null;
      }
    },
  };
}
export type OwnerAuth = ReturnType<typeof createOwnerAuth>;
