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
  createConsentsService,
  createTenantContext,
  currentTransaction,
  normalizeInvitationEmail,
  type Database,
} from '@stakeframe/db';
import type { EnabledAuthConfig } from './auth-config.js';
import type { EmailService } from './email-service.js';

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
  options: { emailService?: EmailService } = {},
) {
  const tenant = createTenantContext(database);
  const invitations = createBetaInvitation(database);
  const consents = createConsentsService(database);
  const emailService = options.emailService;
  const emailPasswordEnabled = Boolean(emailService);
  // Bounded in-process guard against duplicate new-login alerts for the same session.
  const alertedSessions = new Map<string, number>();
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
  /**
   * Deterministic "new login" criterion (documented in docs/F1-06-AUTH-RESEND.md): a
   * committed session whose (IP, user-agent) pair matches no earlier session of the same
   * user — requiring at least one earlier session (the very first access never alerts)
   * and a complete fingerprint (missing IP or user-agent never alerts). Everything here
   * is swallowed on failure: the alert never blocks, fails or slows the login.
   */
  async function maybeSendNewLoginAlert(session: {
    id?: unknown;
    userId?: unknown;
    ipAddress?: unknown;
    userAgent?: unknown;
    createdAt?: unknown;
  }): Promise<void> {
    try {
      if (!emailService) return;
      if (typeof session.id !== 'string' || typeof session.userId !== 'string') return;
      if (alertedSessions.has(session.id)) return;
      const ip = typeof session.ipAddress === 'string' ? session.ipAddress.trim() : '';
      const userAgent = typeof session.userAgent === 'string' ? session.userAgent.trim() : '';
      if (!ip || !userAgent) return;
      const rows = await database.orm
        .select({
          id: authSchema.session.id,
          ipAddress: authSchema.session.ipAddress,
          userAgent: authSchema.session.userAgent,
        })
        .from(authSchema.session)
        .where(eq(authSchema.session.userId, session.userId));
      const previous = rows.filter((row) => row.id !== session.id);
      if (previous.length === 0) return;
      if (previous.some((row) => row.ipAddress === ip && row.userAgent === userAgent)) return;
      if (alertedSessions.size >= 500) alertedSessions.clear();
      alertedSessions.set(session.id, Date.now());
      const identity = await database.orm
        .select({ email: authSchema.user.email, emailVerified: authSchema.user.emailVerified })
        .from(authSchema.user)
        .where(eq(authSchema.user.id, session.userId))
        .limit(1);
      const user = identity[0];
      if (!user || user.emailVerified !== true) return;
      await emailService.sendNewLoginAlert({
        to: user.email,
        when: session.createdAt instanceof Date ? session.createdAt : new Date(),
      });
    } catch {
      // Sanitized by omission: alert problems never surface and never affect the login.
    }
  }
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
          resetPasswordTokenExpiresIn: 1_800,
          revokeSessionsOnPasswordReset: true,
          sendResetPassword: async ({
            user,
            token,
          }: {
            user: { id: string; email: string };
            token: string;
          }) => {
            try {
              if (typeof user?.email !== 'string' || user.email.toLowerCase() === config.ownerEmail)
                return; // the owner identity never holds a password
              const credential = await database.orm
                .select({ id: authSchema.account.id })
                .from(authSchema.account)
                .where(
                  and(
                    eq(authSchema.account.userId, user.id),
                    eq(authSchema.account.providerId, 'credential'),
                  ),
                )
                .limit(1);
              if (credential.length === 0) return; // Google-only accounts have no password
              await emailService!.sendPasswordResetEmail({ to: user.email, token });
            } catch {
              // Sanitized by omission: the public answer stays generic (anti-enumeration)
              // and no provider/driver detail escapes.
            }
          },
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
            }: {
              user: { email: string };
              url: string;
            }) => {
              // Delivered through the configured e-mail service (Resend in production, the
              // controlled in-memory adapter in local/CI); the token only lives inside the
              // action URL of the rendered message.
              await emailService!.sendVerificationEmail({ to: user.email, url });
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
        '/send-verification-email': { window: 300, max: 3 },
        '/request-password-reset': { window: 300, max: 3 },
        '/reset-password': { window: 300, max: 5 },
        '/verify-email': { window: 300, max: 10 },
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
          after: async (session) => {
            // Runs after the session transaction commits (queueAfterTransactionHook):
            // a rolled-back login never produces an alert.
            await maybeSendNewLoginAlert(
              session as {
                id?: unknown;
                userId?: unknown;
                ipAddress?: unknown;
                userAgent?: unknown;
                createdAt?: unknown;
              },
            );
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
    consents,
    beta: {
      emailPasswordEnabled,
      readAcceptableInvitation: invitations.readAcceptableInvitation,
    },
    /**
     * Authentication-only identity check (session + admission). Used by the consent
     * endpoints, which must stay reachable before the consent gate is satisfied; it never
     * resolves or provisions any organization context.
     */
    async getIdentity(headers: Headers) {
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
      return { user: { id: session.user.id, name: session.user.name }, expiresAt: session.session.expiresAt.toISOString() };
    },
    /**
     * Full access check used by every private route: session + admission + the versioned
     * consent gate. Without a current acceptance for every required document the caller
     * gets `consent_required` — the organization is neither resolved nor provisioned, so
     * no private context is exposed before consent.
     */
    async getOwner(headers: Headers) {
      const identity = await this.getIdentity(headers);
      if (!identity) return null;
      try {
        const consentStatus = await consents.statusFor(identity.user.id);
        if (!consentStatus.allAccepted) return { status: 'consent_required' as const };
        await tenant.ensureOrganizationMembership(identity.user.id);
        const organization = await tenant.resolveOrganizationContext(identity.user.id);
        return {
          status: 'ok' as const,
          user: identity.user,
          organization: { id: organization.organizationId, role: organization.role },
          expiresAt: identity.expiresAt,
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
