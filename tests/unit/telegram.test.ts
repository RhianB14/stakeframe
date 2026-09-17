import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  TelegramOperationError,
  createTelegramClient,
  type TelegramConfig,
} from '../../apps/worker/src/telegram.js';
import { buildImportMessage, grossReturn } from '../../apps/worker/src/telegram-message.js';
import { validateTelegramInitData } from '../../apps/api/src/telegram-init-data.js';
import { draftUpdateSchema, parseCaption } from '../../packages/shared/src/index.js';

const config: TelegramConfig = { token: '123456:TEST-TOKEN', userId: '999', chatId: '42' };
const json = (body: unknown, status = 200) => Response.json(body, { status });

describe('telegram gross return (R5)', () => {
  it('computes stake × total odds with exact decimal math', () => {
    expect(grossReturn('10.00', '2.50')).toBe('25.00');
    expect(grossReturn('25.50', '2.10')).toBe('53.55');
    expect(grossReturn('0.01', '1.0000')).toBe('0.01');
    expect(grossReturn('1.00', '1.005')).toBe('1.01');
    expect(grossReturn('100.00', '3.3333')).toBe('333.33');
  });
  it('refuses malformed inputs instead of guessing', () => {
    expect(grossReturn('10.005', '2.00')).toBeNull();
    expect(grossReturn('10.00', '2.00000')).toBeNull();
    expect(grossReturn('abc', '2.00')).toBeNull();
    expect(grossReturn('10.00', '-2.00')).toBeNull();
  });
});

describe('telegram client operations (R5)', () => {
  const client = (fetchImpl: typeof fetch) => createTelegramClient(config, fetchImpl);
  it('sends the processing/result message and returns the message id', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ ok: true, result: { message_id: 77 } }));
    const result = await client(fetchImpl).sendMessage(42, 'texto', { replyToMessageId: 10 });
    expect(result).toEqual({ messageId: 77 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.telegram.org/bot123456:TEST-TOKEN/sendMessage');
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(body).toMatchObject({ chat_id: 42, text: 'texto', reply_to_message_id: 10 });
  });
  it('respects retry_after on 429 as a transient failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        json({ ok: false, error_code: 429, parameters: { retry_after: 7 } }, 429),
      );
    await expect(client(fetchImpl).sendMessage(42, 'texto')).rejects.toMatchObject({
      code: 'TELEGRAM_RATE_LIMITED',
    });
    try {
      await client(fetchImpl).sendMessage(42, 'texto');
    } catch (error) {
      expect(error).toBeInstanceOf(TelegramOperationError);
      expect((error as TelegramOperationError).info.retryAfterSeconds).toBe(7);
    }
  });
  it('treats 403 as a permanent failure without looping', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked' }, 403),
      );
    await expect(client(fetchImpl).sendMessage(42, 'texto')).rejects.toMatchObject({
      code: 'TELEGRAM_PERMANENT',
      info: { permanent: true },
    });
  });
  it("treats 'not modified' edits as success and missing messages as idempotent deletes", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(
          { ok: false, error_code: 400, description: 'Bad Request: message is not modified' },
          400,
        ),
      )
      .mockResolvedValueOnce(
        json(
          { ok: false, error_code: 400, description: 'Bad Request: message to delete not found' },
          400,
        ),
      );
    await expect(client(fetchImpl).editMessageText(42, 5, 'novo')).resolves.toBeUndefined();
    await expect(client(fetchImpl).deleteMessage(42, 5)).resolves.toEqual({ missing: true });
  });
  it('classifies network failures as transient connection errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(client(fetchImpl).sendMessage(42, 'texto')).rejects.toMatchObject({
      code: 'TELEGRAM_CONNECTION_FAILED',
    });
  });
});

describe('telegram initData validation (R5)', () => {
  const token = '123456:SECRET-TOKEN';
  const sign = (fields: Record<string, string>) => {
    const params = new URLSearchParams(fields);
    const pairs = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    params.set('hash', createHmac('sha256', secret).update(pairs).digest('hex'));
    return params.toString();
  };
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  const fields = {
    auth_date: String(Math.floor(now / 1000)),
    query_id: 'AAF',
    user: JSON.stringify({ id: 424242, first_name: 'Rhian' }),
  };
  it('accepts a correctly signed payload and returns the user', () => {
    const validated = validateTelegramInitData(sign(fields), token, now);
    expect(validated?.user.id).toBe(424242);
  });
  it('rejects tampered, expired, unsigned or foreign-signed payloads', () => {
    expect(validateTelegramInitData(sign(fields), '999999:OTHER-TOKEN', now)).toBeNull();
    const tampered = new URLSearchParams(sign(fields));
    tampered.set('user', JSON.stringify({ id: 999 }));
    expect(validateTelegramInitData(tampered.toString(), token, now)).toBeNull();
    expect(validateTelegramInitData(sign(fields), token, now + 2 * 24 * 3600 * 1000)).toBeNull();
    expect(validateTelegramInitData('query_id=AAF', token, now)).toBeNull();
    expect(
      validateTelegramInitData(sign(fields).replace('hash=', 'hash=0'), token, now),
    ).toBeNull();
  });
});

describe('draft update contract (R5)', () => {
  it('accepts origin, credit and date combinations consistently', () => {
    expect(draftUpdateSchema.parse({ version: 2, betOrigin: 'real' })).toMatchObject({
      betOrigin: 'real',
    });
    expect(
      draftUpdateSchema.parse({
        version: 2,
        betOrigin: 'freebet',
        freebetId: '10000000-0000-4000-8000-000000000009',
      }),
    ).toBeTruthy();
    expect(draftUpdateSchema.parse({ version: 2, eventAt: null })).toMatchObject({ eventAt: null });
  });
  it('rejects ambiguous or contradictory selections', () => {
    const credit = '10000000-0000-4000-8000-000000000009';
    expect(() =>
      draftUpdateSchema.parse({ version: 2, betOrigin: 'real', freebetId: credit }),
    ).toThrow();
    expect(() => draftUpdateSchema.parse({ version: 2, betOrigin: 'freebet' })).toThrow();
    expect(() => draftUpdateSchema.parse({ version: 0 })).toThrow();
    expect(() => draftUpdateSchema.parse({ version: 2, extra: true })).toThrow();
  });
  it('keeps the two-line caption contract without origin or date', () => {
    const labels = parseCaption('Tipster\nCasa');
    expect(labels).toEqual({ tipster: 'Tipster', bookmaker: 'Casa', requiresReview: false });
  });
});

describe('import message rendering (R5)', () => {
  const extraction = {
    bookmaker: 'Bet365',
    reference: null,
    placedAtText: '17/09/2026 10:00',
    currency: 'BRL',
    stake: '25.50',
    odds: '2.10',
    potentialReturn: null,
    freebet: null,
    selections: [
      {
        event: 'A x B',
        sport: 'Futebol',
        market: 'Resultado',
        selection: 'A',
        odds: null,
        eventDateText: null,
      },
    ],
    warnings: [],
  };
  const row = (over: Record<string, unknown> = {}) => ({
    id: '11111111-2222-3333-4444-555555555555',
    state: 'review',
    caption: 'Analista\nBet365',
    extraction,
    bet_origin: null as string | null,
    event_at: null as Date | null,
    event_date_status: 'pending',
    telegram_received_at: new Date('2026-09-17T13:00:00Z'),
    ...over,
  });
  it('shows the provisional received instant while the event date is pending', () => {
    const text = buildImportMessage(row());
    expect(text).toContain('Origem financeira: confirmar');
    expect(text).toContain('Retorno potencial: R$ 53,55');
    expect(text).toContain('data provisória');
    expect(text).not.toContain('confirmado');
  });
  it('shows the confirmed event date and the declared origin after confirmation', () => {
    const text = buildImportMessage(
      row({
        bet_origin: 'real',
        event_at: new Date('2026-09-20T18:30:00Z'),
        event_date_status: 'confirmed',
      }),
    );
    expect(text).toContain('Origem financeira: Dinheiro real');
    expect(text).toContain('(confirmado)');
    expect(text).not.toContain('data provisória');
  });
  it('never leaks internal identifiers into the message', () => {
    const text = buildImportMessage(row({ bet_origin: 'freebet' }));
    for (const secret of [row().id, 'chat', '900', 'TOKEN']) expect(text).not.toContain(secret);
  });
});
