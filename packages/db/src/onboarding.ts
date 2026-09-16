/**
 * Onboarding service (STK-F1-09; organization-scoped since STK-F1-13).
 *
 * - Persisted state: `core.onboarding_state` (one row per user, scoped by the user's
 *   organization). Only what the financial records cannot answer is stored here — the display
 *   name lives in `auth."user"`, and the timezone, the deferral choice and the completion marks
 *   in the onboarding row.
 * - Derived steps: the bankroll step reflects `finance.settings.initialized` and the first-bet
 *   step reflects a registered bet (or the explicit deferral). Both are read from the financial
 *   core inside the authenticated organization context — RLS scopes the reads — so the
 *   onboarding consumes exactly the organization's own financial state (no anchor, no
 *   suppressions, no duplicated accounting).
 * - The `finish` gate is enforced on the server (a direct API call cannot bypass it): the
 *   profile must be complete, the bankroll must be configured for the authenticated
 *   organization, and the first-bet step must be resolved by a registered bet
 *   (`firstBet: "registered"`, verified, never trusted) or by the explicit deferral
 *   (`firstBet: "deferred"`).
 * - Every error is the sanitized code itself — no SQL, table, host or personal data.
 */
import { and, eq } from 'drizzle-orm';
import { authSchema } from './auth-schema.js';
import { onboardingState } from './core-schema.js';
import { TenantContextError, createTenantContext } from './tenant-context.js';
import type { Database } from './index.js';

export type OnboardingErrorCode = 'ONBOARDING_PREREQUISITE';

export class OnboardingError extends Error {
  constructor(public readonly code: OnboardingErrorCode) {
    super(code);
    this.name = 'OnboardingError';
  }
}

export type FirstBetResolution = 'registered' | 'deferred';

export type OnboardingStatus = {
  displayName: string;
  timezone: string | null;
  steps: {
    profile: { completed: boolean; completedAt: Date | null };
    bankroll: { completed: boolean };
    firstBet: { completed: boolean; resolution: FirstBetResolution | null };
  };
  completedAt: Date | null;
};

export type OnboardingProfileUpdate = { displayName: string; timezone: string };

export function createOnboardingService(database: Database) {
  const tenant = createTenantContext(database);

  /** Returns the authenticated user's organization context (provisioning on first use). */
  function ensureContext(userId: string) {
    return tenant.ensureOrganizationMembership(userId);
  }

  async function displayNameOf(userId: string): Promise<string> {
    const rows = await database.orm
      .select({ name: authSchema.user.name })
      .from(authSchema.user)
      .where(eq(authSchema.user.id, userId))
      .limit(1);
    return rows[0]?.name ?? '';
  }

  async function statusFor(userId: string): Promise<OnboardingStatus> {
    // Idempotent: the organization exists after the authenticated access flow; this call only
    // makes the service safe to use on its own (tests included).
    const context = await tenant.ensureOrganizationMembership(userId);
    const rows = await database.orm
      .select({
        timezone: onboardingState.timezone,
        profileCompletedAt: onboardingState.profileCompletedAt,
        firstBetDeferredAt: onboardingState.firstBetDeferredAt,
        completedAt: onboardingState.completedAt,
      })
      .from(onboardingState)
      .where(
        and(
          eq(onboardingState.userId, userId),
          eq(onboardingState.organizationId, context.organizationId),
        ),
      )
      .limit(1);
    const row = rows[0];
    const [displayName, flags] = await Promise.all([
      displayNameOf(userId),
      // The financial core answers for THIS organization (RLS inside the transaction context).
      tenant.withOrganizationTransaction(context, async (client) => {
        const settings = await client.query<{ initialized: boolean }>(
          "select initialized from finance.settings where organization_id=current_setting('app.organization_id', true)::uuid",
        );
        const bets = await client.query<{ recorded: boolean }>(
          'select exists(select 1 from finance.bet) as recorded',
        );
        return {
          initialized: settings.rows[0]?.initialized === true,
          firstBet: bets.rows[0]?.recorded === true,
        };
      }),
    ]);
    const resolution: FirstBetResolution | null = flags.firstBet
      ? 'registered'
      : row?.firstBetDeferredAt != null
        ? 'deferred'
        : null;
    return {
      displayName,
      timezone: row?.timezone ?? null,
      steps: {
        profile: {
          completed: row?.profileCompletedAt != null,
          completedAt: row?.profileCompletedAt ?? null,
        },
        bankroll: { completed: flags.initialized },
        firstBet: { completed: resolution !== null, resolution },
      },
      completedAt: row?.completedAt ?? null,
    };
  }

  async function updateProfile(
    userId: string,
    update: OnboardingProfileUpdate,
  ): Promise<OnboardingStatus> {
    const context = await tenant.ensureOrganizationMembership(userId);
    await tenant.withOrganizationTransaction(context, async (client) => {
      await client.query('update auth."user" set name = $2 where id = $1', [
        userId,
        update.displayName,
      ]);
      const result = await client.query(
        `insert into core.onboarding_state as state
           (user_id, organization_id, timezone, profile_completed_at, updated_at)
         values ($1, $2, $3, now(), now())
         on conflict (user_id) do update set
           timezone = excluded.timezone,
           profile_completed_at = coalesce(state.profile_completed_at,
                                          excluded.profile_completed_at),
           updated_at = now()
         where state.organization_id = excluded.organization_id`,
        [userId, context.organizationId, update.timezone],
      );
      // The row can only be absent when the write was refused by the organization guard.
      if (result.rowCount !== 1) throw new TenantContextError('ORGANIZATION_MISMATCH');
    });
    return statusFor(userId);
  }

  /**
   * Explicit conclusion, gated on the server inside the same transaction as the write:
   * profile complete, bankroll configured for the authenticated organization, and the
   * first-bet step resolved either by a registered bet (verified here, never trusted from the
   * payload) or by the user's explicit `deferred` choice. Repeating is idempotent (`coalesce`
   * keeps the first instants) and concurrent repetitions serialize on the same row without
   * duplicating.
   */
  async function finish(userId: string, firstBet: FirstBetResolution): Promise<OnboardingStatus> {
    const context = await tenant.ensureOrganizationMembership(userId);
    await tenant.withOrganizationTransaction(context, async (client) => {
      const state = await client.query<{
        profile_completed_at: Date | null;
        first_bet_deferred_at: Date | null;
        completed_at: Date | null;
      }>(
        `select profile_completed_at, first_bet_deferred_at, completed_at
           from core.onboarding_state
          where user_id = $1 and organization_id = $2
          for update`,
        [userId, context.organizationId],
      );
      const row = state.rows[0];
      if (row?.profile_completed_at == null) throw new OnboardingError('ONBOARDING_PREREQUISITE');

      const settings = await client.query<{ initialized: boolean }>(
        "select initialized from finance.settings where organization_id=current_setting('app.organization_id', true)::uuid",
      );
      if (settings.rows[0]?.initialized !== true)
        throw new OnboardingError('ONBOARDING_PREREQUISITE');

      const bets = await client.query<{ recorded: boolean }>(
        'select exists(select 1 from finance.bet) as recorded',
      );
      const hasBet = bets.rows[0]?.recorded === true;
      // "registered" must be backed by a real bet; "deferred" is the explicit choice and is
      // recorded below (coalesce keeps the first deferral instant).
      if (firstBet === 'registered' && !hasBet)
        throw new OnboardingError('ONBOARDING_PREREQUISITE');

      const result = await client.query(
        `insert into core.onboarding_state as state
           (user_id, organization_id, first_bet_deferred_at, completed_at, updated_at)
         values ($1, $2, case when $3 then now() else null end, now(), now())
         on conflict (user_id) do update set
           first_bet_deferred_at = case
             when $3 then coalesce(state.first_bet_deferred_at, excluded.first_bet_deferred_at)
             else state.first_bet_deferred_at
           end,
           completed_at = coalesce(state.completed_at, excluded.completed_at),
           updated_at = now()
         where state.organization_id = excluded.organization_id`,
        [userId, context.organizationId, firstBet === 'deferred'],
      );
      if (result.rowCount !== 1) throw new TenantContextError('ORGANIZATION_MISMATCH');
    });
    return statusFor(userId);
  }

  return { ensureContext, statusFor, updateProfile, finish };
}

export type OnboardingService = ReturnType<typeof createOnboardingService>;
