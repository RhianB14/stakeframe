import { apiErrorSchema } from '@stakeframe/shared';

export type AuthActionResult =
  { ok: true; body: unknown } | { ok: false; code: string; message: string };

/**
 * Posts to the application auth API and returns a sanitized result. Server error messages
 * are already safe for display (stable codes, PT-BR text, no provider/driver detail);
 * anything unexpected falls back to a single generic message.
 */
export async function authPost(path: string, payload: object): Promise<AuthActionResult> {
  try {
    const response = await fetch(`/api/auth/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true, body };
    const parsed = apiErrorSchema.safeParse(body);
    return parsed.success
      ? { ok: false, code: parsed.data.error.code, message: parsed.data.error.message }
      : {
          ok: false,
          code: 'AUTH_ACTION_FAILED',
          message: 'Não foi possível concluir. Confira os dados e tente novamente.',
        };
  } catch {
    return {
      ok: false,
      code: 'NETWORK_UNAVAILABLE',
      message: 'Não foi possível conectar. Verifique sua conexão e tente novamente.',
    };
  }
}
