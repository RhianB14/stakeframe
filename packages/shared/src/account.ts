import { z } from 'zod';

/** STK-F1-08 account deletion lifecycle, as returned by the account routes. */
export const accountDeletionStatusSchema = z
  .object({
    state: z.enum(['pending', 'cancelled', 'purged']),
    requestedAt: z.string(),
    expiresAt: z.string(),
    cancelledAt: z.string().nullable(),
    purgedAt: z.string().nullable(),
  })
  .meta({ id: 'AccountDeletionStatus' });

export type AccountDeletionStatus = z.infer<typeof accountDeletionStatusSchema>;

export const accountDeletionResponseSchema = z
  .object({ deletion: accountDeletionStatusSchema })
  .meta({ id: 'AccountDeletionResponse' });

export type AccountDeletionResponse = z.infer<typeof accountDeletionResponseSchema>;
