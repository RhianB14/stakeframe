import { describe, expect, it, vi } from 'vitest';
import { OPENROUTER_MODEL, parseCaption } from '../../packages/shared/src/index.js';
import { extractTicket, readAiConfig } from '../../apps/worker/src/openrouter.js';
import {
  authorizedImage,
  pollTelegramOnce,
  readTelegramConfig,
} from '../../apps/worker/src/telegram.js';
import { readBounded } from '../../apps/worker/src/http.js';

const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
const extraction = {
  bookmaker: 'Casa de teste',
  reference: null,
  placedAtText: null,
  currency: 'BRL',
  stake: '10.00',
  odds: '2.00',
  potentialReturn: null,
  freebet: null,
  selections: [
    {
      event: 'Time A x Time B',
      sport: null,
      market: 'Gols',
      selection: 'Mais de 2',
      odds: null,
      eventDateText: null,
    },
  ],
  warnings: [],
};
const completion = {
  id: 'test-completion',
  model: OPENROUTER_MODEL,
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(extraction) } }],
};
const config = {
  token: '123456:synthetic-token-not-a-real-credential',
  userId: '12345',
  chatId: '12345',
};
const update = {
  update_id: 10,
  message: {
    message_id: 20,
    date: 1788745305,
    from: { id: 12345, is_bot: false },
    chat: { id: 12345, type: 'private' },
    caption: 'Tipster\nCasa',
    photo: [{ file_id: 'photo1', file_unique_id: 'unique1', width: 100, height: 200 }],
  },
};

describe('OpenRouter boundary', () => {
  it('is opt-in and refuses unapproved models, fallback and larger limits', () => {
    expect(readAiConfig({})).toBeNull();
    const env = {
      AI_ENABLED: 'true',
      AI_PROVIDER: 'openrouter',
      OPENROUTER_MODEL,
      OPENROUTER_ALLOW_FALLBACKS: 'false',
      OPENROUTER_API_KEY: `sk-or-v1-${'0'.repeat(64)}`,
    };
    expect(readAiConfig(env)).not.toBeNull();
    for (const change of [
      { OPENROUTER_MODEL: 'another-model' },
      { OPENROUTER_ALLOW_FALLBACKS: 'true' },
      { OPENROUTER_MAX_OUTPUT_TOKENS: '4096' },
    ])
      expect(() => readAiConfig({ ...env, ...change })).toThrow();
  });
  it('uses a fixed endpoint and structured schema, preserves unknown dates, requires review', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(completion));
    const result = await extractTicket({ apiKey: 'test-key', image, fetchImpl });
    expect(result.extraction.selections[0]?.eventDateText).toBeNull();
    expect(result.requiresReview).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const request = JSON.parse(String(init?.body));
    expect(request.provider).toEqual({ allow_fallbacks: false, require_parameters: true });
    expect(request.model).toBe(OPENROUTER_MODEL);
    expect(request.response_format.json_schema.strict).toBe(true);
  });
  it.each([402, 429, 503])('never retries HTTP %i automatically', async (status) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('sensitive provider error', { status }));
    await expect(extractTicket({ apiKey: 'test-key', image, fetchImpl })).rejects.toThrow(/^AI_/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('rejects truncation, model substitution, numeric money, and malformed output', async () => {
    for (const payload of [
      { ...completion, model: 'another-model' },
      { ...completion, choices: [{ ...completion.choices[0], finish_reason: 'length' }] },
      {
        ...completion,
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ ...extraction, stake: 10 }) },
          },
        ],
      },
      { ...completion, choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] },
    ])
      await expect(
        extractTicket({
          apiKey: 'test-key',
          image,
          fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)),
        }),
      ).rejects.toThrow(/^AI_/);
  });
  it('sanitizes transport exceptions and bounds response bodies', async () => {
    await expect(
      extractTicket({
        apiKey: 'secret',
        image,
        fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('secret image payload')),
      }),
    ).rejects.toThrow('AI_CONNECTION_FAILED');
    await expect(readBounded(new Response('123456'), 5)).rejects.toThrow('RESPONSE_TOO_LARGE');
  });
});

describe('Telegram boundary', () => {
  it('downloads a valid document when Document and getFile omit optional file_size', async () => {
    const documentUpdate = {
      ...update,
      message: {
        ...update.message,
        photo: undefined,
        document: { file_id: 'document1', file_unique_id: 'unique-doc1', mime_type: 'image/jpeg' },
      },
    };
    const download = vi.fn();
    const inbox = {
      offset: vi.fn().mockResolvedValue(0),
      advance: vi.fn(),
      accept: async (_image: unknown, load: () => Promise<Buffer>) => {
        download(await load());
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, result: [documentUpdate] }))
      .mockResolvedValueOnce(
        Response.json({ ok: true, result: { file_path: 'documents/file_1.jpg' } }),
      )
      .mockResolvedValueOnce(new Response(image));
    await pollTelegramOnce(config, inbox, new AbortController().signal, fetchImpl);
    expect(download).toHaveBeenCalledWith(image);
    expect(inbox.advance).toHaveBeenCalledWith(11);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('is disabled by default and requires matching private identity', () => {
    expect(readTelegramConfig({})).toBeNull();
    expect(() => readTelegramConfig({ TELEGRAM_ENABLED: 'true' })).toThrow();
    expect(authorizedImage(update, config)?.fileId).toBe('photo1');
    for (const message of [
      { ...update.message, from: { id: 999, is_bot: false } },
      { ...update.message, chat: { id: -12345, type: 'group' } },
      { ...update.message, forward_origin: {} },
      { ...update.message, via_bot: {} },
    ])
      expect(authorizedImage({ ...update, message }, config)).toBeNull();
  });
  it('checks identity before downloading or persisting; only advances the cursor for rejected updates', async () => {
    const inbox = { offset: vi.fn().mockResolvedValue(0), accept: vi.fn(), advance: vi.fn() };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        result: [{ ...update, message: { ...update.message, from: { id: 999, is_bot: false } } }],
      }),
    );
    await pollTelegramOnce(config, inbox, new AbortController().signal, fetchImpl);
    expect(inbox.accept).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(inbox.advance).toHaveBeenCalledWith(11);
  });
  it('does not acknowledge an authorized image when durable acceptance fails', async () => {
    const inbox = {
      offset: vi.fn().mockResolvedValue(0),
      accept: vi.fn().mockRejectedValue(new Error('database unavailable')),
      advance: vi.fn(),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, result: [update] }));
    await expect(
      pollTelegramOnce(config, inbox, new AbortController().signal, fetchImpl),
    ).rejects.toThrow('database unavailable');
    expect(inbox.advance).not.toHaveBeenCalled();
  });
  it('parses caption positions deterministically and flags incomplete captions', () => {
    expect(parseCaption(' Tipster \r\n Casa ')).toEqual({
      tipster: 'Tipster',
      bookmaker: 'Casa',
      requiresReview: false,
    });
    expect(parseCaption('\nCasa').tipster).toBeNull();
    expect(parseCaption('Tipster\nCasa\nextra').requiresReview).toBe(true);
  });
});
