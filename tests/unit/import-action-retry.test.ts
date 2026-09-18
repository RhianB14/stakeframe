import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiFailure,
  applyImportBookmaker,
  applyImportOrigin,
} from '../../apps/web/src/product/api.js';

// STK-G0-19-R10 — retry REAL de transporte: somente `ApiFailure` com status 0 e
// código NETWORK_ERROR dispara UMA repetição, reutilizando a MESMA
// idempotency-key e o mesmo corpo; respostas HTTP nunca são repetidas
// automaticamente; nova confirmação intencional gera chave nova.

const okResult = {
  version: 2,
  betState: null,
  bookmakerId: '10000000-0000-4000-8000-000000000001',
  bookmakerName: 'Bet365',
  freebetCleared: false,
};
const okResponse = () =>
  new Response(JSON.stringify(okResult), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const errorResponse = (status: number, code: string) =>
  new Response(
    JSON.stringify({
      error: {
        code,
        message: 'sanitized',
        requestId: '10000000-0000-4000-8000-0000000000ff',
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
type FetchCall = { url: string; key: string | null; body: string | null };
const callsOf = (mock: ReturnType<typeof vi.fn>): FetchCall[] =>
  (mock.mock.calls as [string, RequestInit][]).map(([url, init]) => ({
    url: String(url),
    key: (init.headers as Record<string, string>)['idempotency-key'] ?? null,
    body: String(init.body),
  }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendWithIdempotentRetry (R10)', () => {
  it('retries exactly once on a transport failure with the SAME key and body', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const result = await applyImportBookmaker('import-1', {
      version: 1,
      bookmakerId: '10000000-0000-4000-8000-000000000001',
    });
    expect(result.version).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = callsOf(fetchMock);
    expect(first!.key).toBeTruthy();
    expect(second!.key).toBe(first!.key);
    expect(second!.body).toBe(first!.body);
  });

  it('surfaces an actionable error when the second attempt also fails', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    const failure = await applyImportBookmaker('import-1', {
      version: 1,
      bookmakerId: '10000000-0000-4000-8000-000000000001',
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect((failure as ApiFailure).status).toBe(0);
    expect((failure as ApiFailure).code).toBe('NETWORK_ERROR');
    expect((failure as ApiFailure).message.length).toBeGreaterThan(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never retries an HTTP response: 409 and 500 stay single-shot', async () => {
    for (const [status, code] of [
      [409, 'IDEMPOTENCY_CONFLICT'],
      [500, 'INTERNAL_ERROR'],
    ] as const) {
      const fetchMock = vi.fn().mockResolvedValueOnce(errorResponse(status, code));
      vi.stubGlobal('fetch', fetchMock);
      const failure = await applyImportBookmaker('import-1', {
        version: 1,
        bookmakerId: '10000000-0000-4000-8000-000000000001',
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiFailure);
      expect((failure as ApiFailure).status).toBe(status);
      expect((failure as ApiFailure).code).toBe(code);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('generates a fresh key for each intentional confirmation', async () => {
    const originResponse = () =>
      new Response(
        JSON.stringify({ version: 2, betState: null, kind: 'real', freebetCleared: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(originResponse()));
    vi.stubGlobal('fetch', fetchMock);
    await applyImportOrigin('import-1', { version: 1, kind: 'real' });
    await applyImportOrigin('import-1', { version: 1, kind: 'real' });
    const calls = callsOf(fetchMock);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.key).toBeTruthy();
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
  });
});
