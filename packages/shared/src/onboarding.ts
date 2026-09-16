import { z } from 'zod';

/**
 * Onboarding contract (STK-F1-09).
 *
 * The server is the authority for every rule here: the shared schema backs the API validation
 * and the OpenAPI document, and the browser uses the same helpers only as guidance. A
 * client-side pass never replaces the server-side check.
 */

/**
 * IANA time-zone validation. `Intl.DateTimeFormat` exercises the runtime's own IANA database,
 * so the accepted set matches exactly the names the platform can format with (`UTC` included).
 * The shape check keeps obviously invalid input away from the platform parser.
 */
export function isValidTimeZone(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const name = value.trim();
  if (name.length === 0 || name.length > 64) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(name)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => isValidTimeZone(value), { message: 'INVALID_TIMEZONE' })
  .meta({ id: 'TimeZone' });

export const onboardingStepIdSchema = z.enum(['profile', 'bankroll', 'first_bet']);
export type OnboardingStepId = z.infer<typeof onboardingStepIdSchema>;

/**
 * Progress read model. `profile` and the overall completion are the persisted state; `bankroll`
 * and `firstBet` come from the financial core (single source of truth). `firstBet.resolution`
 * records which explicit path resolved the step — a registered bet or the user's explicit
 * choice to continue without one — and is null while the step is pending.
 */
export const onboardingStatusSchema = z
  .object({
    displayName: z.string(),
    timezone: z.string().nullable(),
    steps: z.object({
      profile: z.object({
        completed: z.boolean(),
        completedAt: z.iso.datetime().nullable(),
      }),
      bankroll: z.object({ completed: z.boolean() }),
      firstBet: z.object({
        completed: z.boolean(),
        resolution: z.enum(['registered', 'deferred']).nullable(),
      }),
    }),
    completedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'OnboardingStatus' });
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;

export const onboardingProfileUpdateSchema = z
  .strictObject({
    step: z.literal('profile'),
    displayName: z.string().trim().min(1).max(120),
    timezone: timeZoneSchema,
  })
  .meta({ id: 'OnboardingProfileUpdate' });

/**
 * Explicit conclusion of the first-bet step. The payload must declare the path: `registered`
 * requires a registered bet (checked on the server) and `deferred` records the user's explicit
 * choice to continue without one ("connect Telegram later"). The server also requires the
 * profile and the bankroll step before accepting either path.
 */
export const onboardingFinishSchema = z
  .strictObject({
    step: z.literal('finish'),
    firstBet: z.enum(['registered', 'deferred']),
  })
  .meta({ id: 'OnboardingFinish' });

export const onboardingUpdateSchema = z
  .discriminatedUnion('step', [onboardingProfileUpdateSchema, onboardingFinishSchema])
  .meta({ id: 'OnboardingUpdate' });
export type OnboardingUpdate = z.infer<typeof onboardingUpdateSchema>;
