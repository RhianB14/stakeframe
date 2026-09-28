import { describe, expect, it, vi } from 'vitest';
import {
  buildTelegramDeepLink,
  parseTelegramStartToken,
  telegramLinkConfirmSchema,
  telegramLinkStatusSchema,
} from '../../packages/shared/src/index.js';
import { authorizedStart, botUsername } from '../../apps/worker/src/telegram-link.js';
import { pollTelegramOnce, type TelegramConfig } from '../../apps/worker/src/telegram.js';

// STK-F2-04 — fronteira do deep link de uso único: o token nunca é aceito fora
// do formato, o deep link é sempre https e o polling continua o MESMO transporte
// (nenhum webhook, nenhuma rota nova).

const config: TelegramConfig = {
  token: '123456:TEST-TOKEN',
  userId: '999',
  chatId: '999',
  miniAppUrl: 'https://app.stakeframe.test',
};
const TOKEN = 'A'.repeat(43);

function startUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 7,
    message: {
      message_id: 11,
      date: 1_700_000_000,
      from: { id: 999, is_bot: false },
      chat: { id: 999, type: 'private' },
      text: `/start ${TOKEN}`,
      ...overrides,
    },
  };
}

describe('deep link do Telegram', () => {
  it('reconhece o comando de início do remetente autorizado e extrai o token', () => {
    const parsed = authorizedStart(startUpdate(), config);
    expect(parsed).toEqual({ updateId: 7, token: TOKEN, telegramUserId: '999' });
  });

  it.each([
    ['remetente não autorizado', { from: { id: 1000, is_bot: false } }],
    ['chat diferente do configurado', { chat: { id: 1000, type: 'private' } }],
    ['grupo em vez de conversa privada', { chat: { id: 999, type: 'group' } }],
    ['remetente bot', { from: { id: 999, is_bot: true } }],
    ['encaminhamento', { forward_origin: { type: 'user' } }],
    ['remetente em nome do chat', { sender_chat: { id: 999 } }],
    ['enviado por outro bot', { via_bot: { id: 1 } }],
    ['conexão de negócio', { business_connection_id: 'bc1' }],
    ['sem texto', { text: undefined }],
  ])('recusa %s sem tocar nada', (_case, overrides) => {
    expect(authorizedStart(startUpdate(overrides), config)).toBeNull();
  });

  it.each([
    ['sem token', '/start'],
    ['token curto demais', '/start abc'],
    ['texto que não é comando', 'hello'],
    ['caractere fora do alfabeto base64url', '/start ' + 'x'.repeat(42) + '!'],
    ['dois tokens', `/start ${TOKEN} ${TOKEN}`],
  ])('o parser de início recusa %s', (_case, text) => {
    expect(parseTelegramStartToken(text)).toBeNull();
  });

  it('aceita o token com menção ao bot, como o Telegram envia em grupos', () => {
    expect(parseTelegramStartToken(`/start@stakeframe_bot ${TOKEN}`)).toBe(TOKEN);
  });

  it('monta o deep link em https do domínio do Telegram e recusa username adulterado', () => {
    expect(buildTelegramDeepLink('stakeframe_rhian_bot', TOKEN)).toBe(
      `https://t.me/stakeframe_rhian_bot?start=${TOKEN}`,
    );
    // Um username fora do formato do Telegram nunca vira link clicável: a
    // construção falha fechada em vez de produzir um link para outro host.
    for (const hostile of [
      'evil.example.com',
      '@stakeframe',
      'bot with space',
      'https://t.me/other',
      'a'.repeat(64),
    ])
      expect(buildTelegramDeepLink(hostile, TOKEN)).toBeNull();
    expect(buildTelegramDeepLink('stakeframe_bot', 'short')).toBeNull();
  });

  it('o contrato de confirmação aceita apenas o token e nunca uma conta', () => {
    expect(telegramLinkConfirmSchema.parse({ token: TOKEN }).token).toBe(TOKEN);
    for (const payload of [
      { token: TOKEN, telegramUserId: '999' },
      { token: TOKEN, telegram_user_id: 999 },
      { token: TOKEN, organizationId: '00000000-0000-4000-8000-000000000001' },
    ])
      expect(telegramLinkConfirmSchema.safeParse(payload).success).toBe(false);
    expect(telegramLinkConfirmSchema.safeParse({}).success).toBe(false);
  });

  it('o estado do vínculo nunca carrega o identificador da conta do Telegram', () => {
    const status = telegramLinkStatusSchema.parse({
      linked: true,
      linkedAt: '2026-09-28T12:00:00.000Z',
      deepLink: null,
      expiresAt: null,
      expiresInSeconds: null,
    });
    expect(JSON.stringify(status)).not.toMatch(/telegram_user_id|telegramUserId|999/);
    expect(telegramLinkStatusSchema.safeParse({ linked: true, linkedAt: null }).success).toBe(
      false,
    );
  });
});

describe('transporte do deep link', () => {
  it('entrega o deep link ao inbox pelo polling existente, sem rota nova', async () => {
    const starts: unknown[] = [];
    const accepted: unknown[] = [];
    const advanced: number[] = [];
    const fetchImpl = vi.fn(
      async () => Response.json({ ok: true, result: [startUpdate()] }) as unknown as Response,
    );
    await pollTelegramOnce(
      config,
      {
        offset: async () => 0,
        advance: async (next) => {
          advanced.push(next);
        },
        accept: async (image) => {
          accepted.push(image);
        },
        start: async (start) => {
          starts.push(start);
        },
      },
      AbortSignal.timeout(5_000),
      fetchImpl as unknown as typeof fetch,
    );
    expect(starts).toEqual([{ updateId: 7, token: TOKEN, telegramUserId: '999' }]);
    expect(accepted).toHaveLength(0);
    expect(advanced).toEqual([8]);
  });

  it('ignora o deep link quando o inbox não expõe o handler (compatibilidade)', async () => {
    const fetchImpl = vi.fn(
      async () => Response.json({ ok: true, result: [startUpdate()] }) as unknown as Response,
    );
    await expect(
      pollTelegramOnce(
        config,
        {
          offset: async () => 0,
          advance: async () => {},
          accept: async () => {},
        },
        AbortSignal.timeout(5_000),
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('username público do bot', () => {
  it('lê o username de getMe e recusa qualquer valor fora do formato', async () => {
    const ok = vi.fn(
      async () =>
        Response.json({
          ok: true,
          result: { username: 'stakeframe_rhian_bot' },
        }) as unknown as Response,
    );
    await expect(botUsername(config, ok as unknown as typeof fetch)).resolves.toBe(
      'stakeframe_rhian_bot',
    );

    for (const payload of [
      { ok: true, result: { username: 'https://t.me/evil' } },
      { ok: true, result: { username: '@bot' } },
      { ok: false, result: {} },
      { ok: true, result: {} },
    ]) {
      const fail = vi.fn(async () => Response.json(payload) as unknown as Response);
      await expect(botUsername(config, fail as unknown as typeof fetch)).resolves.toBeNull();
    }

    const refused = vi.fn(async () => new Response('nope', { status: 401 }));
    await expect(botUsername(config, refused as unknown as typeof fetch)).resolves.toBeNull();
    const offline = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(botUsername(config, offline as unknown as typeof fetch)).resolves.toBeNull();
  });
});
