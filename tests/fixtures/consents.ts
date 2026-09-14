import type { createApp } from '../../apps/api/src/app.js';

type TestApp = ReturnType<typeof createApp>;

/** Stable catalog types; mirrors the server-side enum (never display text). */
export const REQUIRED_CONSENT_TYPES = ['terms_of_use', 'privacy_policy', 'minimum_age'] as const;

export type ConsentAcceptResponse = { statusCode: number; body: string; json: () => unknown };

/**
 * Records the acceptance of every required, currently effective legal document for the
 * session in `cookie`. Shared by the integration suites whose flows must now pass the
 * consent gate before reaching the private app.
 */
export async function acceptRequiredConsents(
  app: TestApp,
  cookie: string,
  options: { origin: string; remoteAddress?: string },
): Promise<ConsentAcceptResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/consents/accept',
    remoteAddress: options.remoteAddress ?? '192.0.2.251',
    headers: { cookie, origin: options.origin },
    payload: { documents: REQUIRED_CONSENT_TYPES.map((type) => ({ type })) },
  });
}
