import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  OPENROUTER_MODEL,
  OPENROUTER_MODELS,
  parseCaption,
} from '../../packages/shared/src/index.js';
import {
  extractTicket,
  providerStructuredSchema,
  rateLimitMetadata,
  readAiConfig,
  TICKET_EXTRACTION_SYSTEM_PROMPT,
} from '../../apps/worker/src/openrouter.js';
import { prepareVisionImage } from '../../apps/worker/src/vision-image.js';
import {
  authorizedImage,
  pollTelegramOnce,
  readTelegramConfig,
} from '../../apps/worker/src/telegram.js';
import { readBounded } from '../../apps/worker/src/http.js';
import type { OcrResult } from '../../apps/worker/src/ocr.js';

const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
const validImage = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));
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
  provider: 'Google AI Studio',
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(extraction) } }],
};
const config = {
  token: '123456:synthetic-token-not-a-real-credential',
  userId: '12345',
  chatId: '12345',
  miniAppUrl: 'https://app.example.test',
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
  it('prepares only a provider view and preserves the original attachment bytes', async () => {
    const prepared = await prepareVisionImage(validImage);
    expect(prepared.image.length).toBeGreaterThan(0);
    expect(prepared.mime).toBe('image/png');
    expect(prepared.image).not.toEqual(validImage);
    expect(validImage).toEqual(
      readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url)),
    );
  });
  it('is opt-in and refuses unapproved models, fallback and larger limits', () => {
    expect(readAiConfig({})).toBeNull();
    const env = {
      AI_ENABLED: 'true',
      AI_PROVIDER: 'openrouter',
      OPENROUTER_MODEL,
      OPENROUTER_ALLOW_FALLBACKS: 'true',
      OPENROUTER_API_KEY: `sk-or-v1-${'0'.repeat(64)}`,
    };
    expect(readAiConfig(env)).not.toBeNull();
    for (const change of [
      { OPENROUTER_MODEL: 'another-model' },
      { OPENROUTER_ALLOW_FALLBACKS: 'false' },
      { OPENROUTER_MAX_OUTPUT_TOKENS: '2048' },
      { OPENROUTER_REASONING_EFFORT: 'medium' },
    ])
      expect(() => readAiConfig({ ...env, ...change })).toThrow();
  });
  it('uses a fixed endpoint and structured schema, preserves unknown dates, requires review', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(completion));
    const result = await extractTicket({ apiKey: 'test-key', image, fetchImpl });
    expect(result.extraction.selections[0]?.eventDateText).toBeNull();
    expect(result.requiresReview).toBe(true);
    expect(result.provider).toBe('Google AI Studio');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const request = JSON.parse(String(init?.body));
    expect(request.provider).toEqual({
      allow_fallbacks: true,
      require_parameters: true,
      sort: 'throughput',
    });
    expect(request.model).toBeUndefined();
    expect(request.models).toEqual(OPENROUTER_MODELS);
    expect(request.max_tokens).toBe(4096);
    expect(request.reasoning).toBeUndefined();
    expect(request.seed).toBe(0);
    expect(request.temperature).toBeUndefined();
    expect(request.response_format.json_schema.strict).toBe(true);
    const providerSchema = request.response_format.json_schema.schema;
    expect(JSON.stringify(providerSchema)).not.toMatch(
      /"(?:\$schema|maxItems|maxLength|minItems|minLength|pattern)"/,
    );
    expect(providerSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['bookmaker', 'selections', 'warnings']),
      additionalProperties: false,
    });
  });
  it('sends OCR as auxiliary context while retaining the original image path', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(completion));
    const ocr: OcrResult = {
      text: 'Casa de teste\nTime A x Time B\nGols\nMais de 2\n10,00\n2,00',
      pages: [
        {
          width: 100,
          height: 200,
          unit: 'pixels',
          qualityScore: 0.96,
          blocks: [{ text: 'Casa de teste', confidence: 0.99, boundingPoly: [{ x: 0, y: 0 }] }],
          lines: [
            { text: 'Retorno potencial 20,00', confidence: 0.98, boundingPoly: [{ x: 0, y: 0 }] },
          ],
        },
      ],
      averageConfidence: 0.985,
      averageQualityScore: 0.96,
    };
    await extractTicket({ apiKey: 'test-key', image, fetchImpl, ocr });
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    const userContent = request.messages[1].content;
    expect(userContent.some((part: { type: string }) => part.type === 'image_url')).toBe(true);
    const ocrPart = userContent.find((part: { type: string }) => part.type === 'text');
    expect(ocrPart.text).toContain('[OCR estruturado auxiliar');
    expect(ocrPart.text).toContain('Time A x Time B');
    expect((await extractTicket({ apiKey: 'test-key', image, fetchImpl, ocr })).ocrConsistent).toBe(
      true,
    );
  });
  it.each(OPENROUTER_MODELS)('accepts the fixed model response %s', async (model) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...completion, model }));
    const result = await extractTicket({ apiKey: 'test-key', image, fetchImpl });
    expect(result.model).toBe(model);
    expect(result.requiresReview).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('uses a field-specific fail-closed extraction prompt', () => {
    for (const rule of [
      '[Procedimento obrigatório]',
      'inclusive 0.00',
      'retorno líquido',
      'Nunca derive potentialReturn',
      '[Exemplos sintéticos]',
      'Leia cada seleção uma por uma',
      'bookmaker é independente do contexto',
      '[Warnings]',
      'somente com o objeto JSON',
      '[Freebet]',
      'aposta grátis',
      'Ausência de indicação não prova',
      '[Eventos empilhados]',
      'participante 1 x participante 2',
      'Nunca escolha entre x, v e vs',
    ])
      expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain(rule);
  });
  it('does not train freebet:false without explicit evidence and keeps the example neutral', () => {
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('"freebet":null');
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).not.toContain('"freebet":false');
  });
  it('marks ambiguity instead of guessing a stacked-event separator', () => {
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('associação for ambígua');
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('warnings');
  });
  it('simplifies provider constraints recursively without weakening local validation', async () => {
    expect(
      providerStructuredSchema({
        $schema: 'draft',
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1, pattern: '^x$' },
      }),
    ).toEqual({ type: 'array', items: { type: 'string' } });
    await expect(
      extractTicket({
        apiKey: 'test-key',
        image,
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            ...completion,
            choices: [
              {
                finish_reason: 'stop',
                message: { content: JSON.stringify({ ...extraction, stake: 'x' }) },
              },
            ],
          }),
        ),
      }),
    ).rejects.toThrow('AI_EXTRACTION_INVALID');
  });
  it.each([402, 429, 503])('never retries HTTP %i automatically', async (status) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('sensitive provider error', { status }));
    await expect(extractTicket({ apiKey: 'test-key', image, fetchImpl })).rejects.toThrow(/^AI_/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('preserves only numeric rate-limit headers and never the provider body', async () => {
    const response = new Response('secret provider payload', {
      status: 429,
      headers: {
        'retry-after': '60',
        'x-ratelimit-limit': '200',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1789516800',
        'x-provider-secret': 'must-not-escape',
      },
    });
    const error = await extractTicket({
      apiKey: 'test-key',
      image,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'AI_RATE_LIMITED',
      safeMetadata: {
        retryAfterSeconds: 60,
        limit: 200,
        remaining: 0,
        reset: 1789516800,
      },
    });
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(rateLimitMetadata(new Headers({ 'retry-after': 'private value' }))).toEqual({});
  });
  it.each([400, 422])('classifies HTTP %i as a sanitized invalid request', async (status) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('sensitive provider error', { status }));
    await expect(extractTicket({ apiKey: 'test-key', image, fetchImpl })).rejects.toThrow(
      'AI_REQUEST_INVALID',
    );
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
  it('parses the tipster+house caption deterministically and fails closed on incomplete captions', () => {
    // R5: a legenda canônica tem exatamente tipster + casa; nenhuma origem,
    // data ou valor é exigido nela (a origem é declarada pelo usuário na UI).
    expect(parseCaption(' Tipster \r\n Casa ')).toEqual({
      tipster: 'Tipster',
      bookmaker: 'Casa',
      requiresReview: false,
    });
    // Linhas extras do legado são toleradas e ignoradas, nunca interpretadas
    // como origem financeira ou data.
    expect(parseCaption(' Tipster \r\n Casa \r\n real ')).toEqual({
      tipster: 'Tipster',
      bookmaker: 'Casa',
      requiresReview: false,
    });
    expect(parseCaption('Tipster\nCasa\nfreebet\n07/09/2026 14:51')).toEqual({
      tipster: 'Tipster',
      bookmaker: 'Casa',
      requiresReview: false,
    });
    expect(parseCaption('\nCasa').tipster).toBeNull();
    expect(parseCaption('\nCasa').requiresReview).toBe(true);
    expect(parseCaption('Tipster\n').bookmaker).toBeNull();
    expect(parseCaption('Tipster\n').requiresReview).toBe(true);
    expect(parseCaption('Tipster\n' + 'a'.repeat(101)).requiresReview).toBe(true);
  });
});

describe('Telegram callback boundary (R6)', () => {
  it('routes authorized callback_query updates to the inbox, advances the offset and drops foreign ones', async () => {
    const updates = [
      {
        update_id: 60,
        callback_query: {
          id: 'cb-1',
          from: { id: 12345 },
          message: { message_id: 77, chat: { id: 12345 } },
          data: 'sf:v1:delete',
        },
      },
      {
        update_id: 61,
        callback_query: {
          id: 'cb-2',
          from: { id: 99999 },
          message: { message_id: 78, chat: { id: 12345 } },
          data: 'sf:v1:delete:confirm',
        },
      },
    ];
    const inbox = {
      offset: vi.fn().mockResolvedValue(0),
      accept: vi.fn(),
      callback: vi.fn(),
      advance: vi.fn(),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, result: updates }));
    await pollTelegramOnce(config, inbox, new AbortController().signal, fetchImpl);
    expect(inbox.accept).not.toHaveBeenCalled();
    // Somente o callback do usuário configurado chega ao handler.
    expect(inbox.callback).toHaveBeenCalledTimes(1);
    expect(inbox.callback.mock.calls[0]![0]).toMatchObject({ action: 'delete', messageId: 77 });
    expect(inbox.advance).toHaveBeenCalledWith(61);
    expect(inbox.advance).toHaveBeenCalledWith(62);
  });
});
