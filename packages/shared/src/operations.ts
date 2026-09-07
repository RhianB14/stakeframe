import { z } from 'zod';

export const operationStateSchema = z.enum(['ready', 'warning', 'failed', 'disabled']);
export const operationsHealthSchema = z
  .object({
    checkedAt: z.iso.datetime(),
    status: z.enum(['ready', 'attention']),
    checks: z
      .object({
        database: operationStateSchema,
        worker: operationStateSchema,
        backup: operationStateSchema,
        restoreTest: operationStateSchema,
        retention: operationStateSchema,
        disk: operationStateSchema,
        importQueue: operationStateSchema,
        attachments: operationStateSchema,
        aiQuota: operationStateSchema,
        aiBudget: operationStateSchema,
        eventQueue: operationStateSchema,
        recovery: operationStateSchema,
      })
      .strict(),
  })
  .strict()
  .meta({ id: 'OperationsHealth' });
export type OperationsHealth = z.infer<typeof operationsHealthSchema>;
export type OperationState = z.infer<typeof operationStateSchema>;
