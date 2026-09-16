/**
 * Onboarding service (STK-F1-09).
 *
 * - Persisted state: `core.onboarding_state` (one row per user, scoped by the user's
 *   organization). Only what the financial records cannot answer is stored here — the display
 *   name lives in `auth."user"`, the timezone and the completion marks in the onboarding row.
 * - Derived steps: the bankroll step reflects `finance.settings.initialized` and the first-bet
 *   step reflects a registered bet. Both are read from the financial core (single source of
 *   truth); this service never duplicates balances, bets or any accounting rule.
 * - The organization always comes from the authenticated user (`ensureOrganizationMembership`,
 *   idempotent) and every statement is scoped by `organization_id`; a row that belongs to a
 *   different organization is never touched (the guarded upsert simply refuses it).
 * - Every error is the sanitized code itself — no SQL, table, host or personal data.
 */
import { and, eq } from 'drizzle-orm';
import { authSchema } from './auth-schema.js';
import { onboardingState } from './core-schema.js';
import { TenantContextError, createTenantContext } from './tenant-context.js';
import type { Database } from './index.js';

export type OnboardingStatus = {
  displayName: string;
  timezone: string | null;
  steps: {
    profile: { completed: boolean; completedAt: Date | null };
    bankroll: { completed: boolean };
    firstBet: { completed: boolean };
  };
  completedAt: Date | null;
};

export type OnboardingProfileUpdate = { displayName: string; timezone: string };

export function createOnboardingService(database: Database) {
  const tenant = createTenantContext(database);

  async function displayNameOf(userId: string): Promise<string> {
    const rows = await database.orm
      .select({ name: authSchema.user.name })
      .from(authSchema.user)
      .where(eq(authSchema.user.id, userId))
      .limit(1);
    return rows[0]?.name ?? '';
  }

  async function financialFlags(): Promise<{ initialized: boolean; firstBet: boolean }> {
    // The financial core is the authority for the bankroll step and for registered bets. It is
    // read-only here — the onboarding never writes accounting state.
    const settings = await database.pool.query<{ initialized: boolean }>(
      'select initialized from finance.settings where id = 1',
    );
    const bets = await database.pool.query<{ recorded: boolean }>(
      'select exists(select 1 from finance.bet limit 1) as recorded',
    );
    return {
      initialized: settings.rows[0]?.initialized === true,
      firstBet: bets.rows[0]?.recorded === true,
    };
  }

  async function statusFor(userId: string): Promise<OnboardingStatus> {
    // Idempotent: the organization exists after the authenticated access flow; this call only
    // makes the service safe to use on its own (tests included).
    const context = await tenant.ensureOrganizationMembership(userId);
    const rows = await database.orm
      .select({
        timezone: onboardingState.timezone,
        profileCompletedAt: onboardingState.profileCompletedAt,
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
    const [displayName, flags] = await Promise.all([displayNameOf(userId), financialFlags()]);
    return {
      displayName,
      timezone: row?.timezone ?? null,
      steps: {
        profile: {
          completed: row?.profileCompletedAt != null,
          completedAt: row?.profileCompletedAt ?? null,
        },
        bankroll: { completed: flags.initialized },
        firstBet: { completed: flags.firstBet },
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

  async function finish(userId: string): Promise<OnboardingStatus> {
    const context = await tenant.ensureOrganizationMembership(userId);
    await tenant.withOrganizationTransaction(context, async (client) => {
      const result = await client.query(
        `insert into core.onboarding_state as state
           (user_id, organization_id, completed_at, updated_at)
         values ($1, $2, now(), now())
         on conflict (user_id) do update set
           completed_at = coalesce(state.completed_at, excluded.completed_at),
           updated_at = now()
         where state.organization_id = excluded.organization_id`,
        [userId, context.organizationId],
      );
      if (result.rowCount !== 1) throw new TenantContextError('ORGANIZATION_MISMATCH');
    });
    return statusFor(userId);
  }

  return { statusFor, updateProfile, finish };
}

export type OnboardingService = ReturnType<typeof createOnboardingService>;
