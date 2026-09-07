import { z } from 'zod';
import { type OperationState } from '@stakeframe/shared';
import { readAiConfig } from './openrouter.js';
import { readJson, IntegrationError } from './http.js';

const keySchema = z.object({
  data: z.object({
    limit: z.number().finite().positive().max(5),
    limit_remaining: z.number().finite().nonnegative(),
    limit_reset: z.literal('monthly'),
    usage_monthly: z.number().finite().nonnegative(),
    is_management_key: z.literal(false),
  }),
});

export function createBudgetProbe(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
  now = Date.now,
) {
  const ai = readAiConfig(env);
  let cached: { at: number; value: OperationState } | undefined;
  let inflight: Promise<OperationState> | undefined;
  const read = async (): Promise<OperationState> => {
    if (!ai) return 'disabled';
    if (cached && now() - cached.at < (cached.value === 'failed' ? 60_000 : 300_000))
      return cached.value;
    if (inflight) return inflight;
    inflight = (async () => {
      let value: OperationState;
      try {
        const response = await fetchImpl('https://openrouter.ai/api/v1/key', {
          headers: { authorization: `Bearer ${ai.apiKey}` },
          redirect: 'error',
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error();
        }
        const parsed = keySchema.parse(await readJson(response, 16384)).data;
        if (parsed.limit_remaining > parsed.limit) throw new Error();
        value =
          parsed.limit_remaining === 0
            ? 'failed'
            : parsed.limit_remaining <= parsed.limit * 0.2
              ? 'warning'
              : 'ready';
      } catch {
        value = 'failed';
      }
      cached = { at: now(), value };
      return value;
    })();
    try {
      return await inflight;
    } finally {
      inflight = undefined;
    }
  };
  return {
    read,
    async requireBudget() {
      const value = await read();
      if (value !== 'ready' && value !== 'warning')
        throw new IntegrationError('AI_BUDGET_UNAVAILABLE');
    },
  };
}
