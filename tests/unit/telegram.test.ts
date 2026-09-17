import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  TelegramOperationError,
  authorizedCallback,
  createTelegramClient,
  readTelegramConfig,
  telegramDeleteConfirmButtons,
  telegramResultButtons,
  type TelegramConfig,
} from '../../apps/worker/src/telegram.js';
import { buildImportMessage, grossReturn } from '../../apps/worker/src/telegram-message.js';
import { validateTelegramInitData } from '../../apps/api/src/telegram-init-data.js';
import {
  draftUpdateSchema,
  parseCaption,
  parseTelegramCallbackData,
} from '../../packages/shared/src/index.js';

const config: TelegramConfig = {
  token: '123456:synthetic-token-not-a-real-credential',
  userId: '999',
  chatId: '42',
  miniAppUrl: 'https://app.stakeframe.test',
};
const json = (body: unknown, status = 200) => Response.json(body, { status });

describe('telegram gross return (R5)', () => {
  it('computes stake × total odds with exact decimal math', () => {
    expect(grossReturn('10.00', '2.50')).toBe('25.00');
    // O bruto é o mesmo para dinheiro real e para freebet (R6): o cálculo não
    // altera saldo, liquidação, lucro, principal ou consumo do crédito.
    expect(grossReturn('100.00', '2.00')).toBe('200.00');
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
    expect(String(url)).toBe(
      'https://api.telegram.org/bot123456:synthetic-token-not-a-real-credential/sendMessage',
    );
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
  const token = ['123456:synthetic-token-not-a-real-credential'].join('');
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

describe('telegram buttons and callbacks (R6)', () => {
  it('builds per-record Mini App URLs for the edit button without duplicating links', () => {
    const first = telegramResultButtons(
      'https://app.stakeframe.test',
      '10000000-0000-4000-8000-000000000001',
    );
    const second = telegramResultButtons(
      'https://app.stakeframe.test',
      '10000000-0000-4000-8000-000000000002',
    );
    const urlOf = (buttons: ReturnType<typeof telegramResultButtons>) =>
      (buttons[0]![0] as { web_app?: { url?: string } }).web_app?.url;
    expect(urlOf(first)).toBe(
      'https://app.stakeframe.test#miniapp?import=10000000-0000-4000-8000-000000000001',
    );
    expect(urlOf(second)).not.toBe(urlOf(first));
    // Nenhum identificador em callback_data; os demais botões só carregam a ação.
    expect(first[0]![0]).not.toHaveProperty('callback_data');
    expect(first[1]![0]).toMatchObject({ callback_data: 'sf:v1:status' });
    expect(first[2]![0]).toMatchObject({ callback_data: 'sf:v1:delete' });
    const confirm = telegramDeleteConfirmButtons();
    expect(confirm[0]![0]).toMatchObject({ callback_data: 'sf:v1:delete:confirm' });
    expect(confirm[1]![0]).toMatchObject({ callback_data: 'sf:v1:delete:cancel' });
  });
  it('parses callback data strictly and refuses unknown or foreign callbacks', () => {
    expect(parseTelegramCallbackData('sf:v1:status')).toBe('status');
    expect(parseTelegramCallbackData('sf:v1:delete:confirm')).toBe('delete_confirm');
    expect(parseTelegramCallbackData('sf:v1:delete:cancel')).toBe('delete_cancel');
    expect(parseTelegramCallbackData('sf:v1:edit')).toBeNull();
    expect(parseTelegramCallbackData('sf:v1:drop')).toBeNull();
    const callback = (over: Record<string, unknown> = {}) => ({
      update_id: 50,
      callback_query: {
        id: 'cb-1',
        from: { id: 999 },
        message: { message_id: 77, chat: { id: 42 } },
        data: 'sf:v1:delete',
        ...over,
      },
    });
    expect(authorizedCallback(callback(), config)).toMatchObject({
      action: 'delete',
      messageId: 77,
      callbackId: 'cb-1',
    });
    // Remetente/chat alheios e dados desconhecidos são recusados.
    const foreignFrom = callback();
    (foreignFrom.callback_query.from as { id: number }).id = 111;
    expect(authorizedCallback(foreignFrom, config)).toBeNull();
    const foreignChat = callback();
    (foreignChat.callback_query.message.chat as { id: number }).id = 111;
    expect(authorizedCallback(foreignChat, config)).toBeNull();
    const unknownData = callback();
    unknownData.callback_query.data = 'sf:v1:edit';
    expect(authorizedCallback(unknownData, config)).toBeNull();
    expect(authorizedCallback({ update_id: 1 }, config)).toBeNull();
  });
  it('requires a valid HTTPS Mini App URL in the telegram configuration', () => {
    const base = {
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: `123456:${'a'.repeat(40)}`,
      TELEGRAM_OWNER_USER_ID: '424242',
      TELEGRAM_OWNER_CHAT_ID: '424242',
    };
    expect(
      readTelegramConfig({ ...base, TELEGRAM_MINIAPP_URL: 'https://app.stakeframe.test' })
        ?.miniAppUrl,
    ).toBe('https://app.stakeframe.test');
    expect(() => readTelegramConfig(base)).toThrow('TELEGRAM_CONFIGURATION_INVALID');
    expect(() =>
      readTelegramConfig({ ...base, TELEGRAM_MINIAPP_URL: 'http://app.stakeframe.test' }),
    ).toThrow('TELEGRAM_CONFIGURATION_INVALID');
    expect(() =>
      readTelegramConfig({
        ...base,
        TELEGRAM_MINIAPP_URL: 'https://user:pass@app.stakeframe.test',
      }),
    ).toThrow('TELEGRAM_CONFIGURATION_INVALID');
    expect(() =>
      readTelegramConfig({ ...base, TELEGRAM_MINIAPP_URL: 'https://app.stakeframe.test/?token=1' }),
    ).toThrow('TELEGRAM_CONFIGURATION_INVALID');
  });
});

describe('telegram initData hardening (R6)', () => {
  const token = ['123456:synthetic-token-not-a-real-credential'].join('');
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  const sign = (fields: Array<[string, string]>) => {
    const params = new URLSearchParams();
    for (const [key, value] of fields) params.append(key, value);
    const pairs = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    params.set('hash', createHmac('sha256', secret).update(pairs).digest('hex'));
    return params.toString();
  };
  const user = JSON.stringify({ id: 424242 });
  it('refuses duplicated sensitive parameters (hash, auth_date, user)', () => {
    const authDate = String(Math.floor(now / 1000));
    // Duplicar DEPOIS de assinar também corrompe o payload: o hash cobre o valor único.
    const duplicatedUser = `${sign([
      ['auth_date', authDate],
      ['user', user],
    ])}&user=${encodeURIComponent('{"id":1}')}`;
    expect(validateTelegramInitData(duplicatedUser, token, now)).toBeNull();
    const duplicatedHash = sign([
      ['auth_date', authDate],
      ['user', user],
    ]).replace(/(hash=[0-9a-f]{64})/, '$1&hash=' + 'a'.repeat(64));
    expect(validateTelegramInitData(duplicatedHash, token, now)).toBeNull();
    const duplicatedAuth = `${sign([
      ['auth_date', authDate],
      ['user', user],
    ])}&auth_date=${authDate}`;
    expect(validateTelegramInitData(duplicatedAuth, token, now)).toBeNull();
  });
  it('refuses future auth_date beyond the small tolerance and accepts it inside', () => {
    const inside = String(Math.floor(now / 1000) + 60);
    const beyond = String(Math.floor(now / 1000) + 600);
    expect(
      validateTelegramInitData(
        sign([
          ['auth_date', inside],
          ['user', user],
        ]),
        token,
        now,
      )?.user.id,
    ).toBe(424242);
    expect(
      validateTelegramInitData(
        sign([
          ['auth_date', beyond],
          ['user', user],
        ]),
        token,
        now,
      ),
    ).toBeNull();
  });
  it('refuses non-positive or unsafe user ids', () => {
    const authDate = String(Math.floor(now / 1000));
    for (const badUser of [
      '{"id":0}',
      '{"id":-5}',
      '{"id":1.5}',
      `{"id":${Number.MAX_SAFE_INTEGER + 2}}`,
    ])
      expect(
        validateTelegramInitData(
          sign([
            ['auth_date', authDate],
            ['user', badUser],
          ]),
          token,
          now,
        ),
      ).toBeNull();
  });
});
