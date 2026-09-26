// STK-F1-10 — testes do scrubber compartilhado (§4.6): nada cru sai.
import { describe, expect, it } from 'vitest';
import {
  sanitizeLogText,
  scrubTelemetry,
  scrubText,
  TELEMETRY_REDACTED,
} from '../../packages/shared/src/telemetry.js';

// Fixture representativa do que NUNCA pode vazar: token de API, JWT, segredo em
// query string, prompt de IA, imagem inline, e-mail, telefone/Telegram e valor
// financeiro de bilhete.
const PII_FIXTURE = {
  user: {
    id: '8b2f6a1c-7e34-4d2a-9f10-2c5b8a3d6e41',
    email: 'rhian@example.com',
    phone: '5511999998888',
  },
  message: 'falha ao processar token sk-abc123456789012345 no bilhete',
  request: { url: 'https://app.example/api/v1/bets?token=abc123def&page=1' },
  authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.cGF5bG9hZA.c2lnbmF0dXJl',
  prompt: 'classifique o bilhete anexado e devolva as seleções',
  screenshot:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ticket: { stakeCents: 1234567890123 },
  context: { release: 'stakeframe@1.2.3+3e1f0c786ae514e1ecd718a9b5589cf5819a22f9' },
};

describe('scrubTelemetry', () => {
  it('remove tokens, prompts, imagens, PII e valores financeiros da fixture', () => {
    const scrubbed = JSON.stringify(scrubTelemetry(PII_FIXTURE));
    for (const secret of [
      'rhian@example.com',
      'sk-abc123456789012345',
      'abc123def',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'classifique o bilhete',
      'data:image/png;base64,iVBORw0KGgo',
      '5511999998888',
      '1234567890123',
    ]) {
      expect(scrubbed).not.toContain(secret);
    }
    expect(scrubbed).toContain(TELEMETRY_REDACTED);
  });

  it('preserva conteúdo inofensivo (release, ids internos, mensagens)', () => {
    const scrubbed = scrubTelemetry({
      release: 'stakeframe@1.2.3+3e1f0c786ae514e1ecd718a9b5589cf5819a22f9',
      snapshot: '3eaecd4f',
      message: 'snapshot 3eaecd4f concluído em 12s',
    }) as Record<string, unknown>;
    expect(scrubbed.release).toBe('stakeframe@1.2.3+3e1f0c786ae514e1ecd718a9b5589cf5819a22f9');
    expect(scrubbed.snapshot).toBe('3eaecd4f');
    expect(scrubbed.message).toBe('snapshot 3eaecd4f concluído em 12s');
  });

  it('redige chaves sensíveis em qualquer profundidade', () => {
    const scrubbed = scrubTelemetry({
      outer: { inner: { password: 'x', chatId: 'y', authorization: 'z' } },
    }) as { outer: { inner: Record<string, unknown> } };
    expect(scrubbed.outer.inner).toEqual({
      password: TELEMETRY_REDACTED,
      chatId: TELEMETRY_REDACTED,
      authorization: TELEMETRY_REDACTED,
    });
  });

  it('limita profundidade e quantidade de itens', () => {
    const deep: Record<string, unknown> = { level: 'ok' };
    let cursor = deep;
    for (let index = 0; index < 10; index += 1) {
      cursor.next = { level: 'ok' };
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(JSON.stringify(scrubTelemetry(deep))).toContain(TELEMETRY_REDACTED);

    const many = scrubTelemetry(Array.from({ length: 120 }, (_, index) => index)) as number[];
    expect(many).toHaveLength(50);
  });

  it('não redige números, booleanos e nulos legítimos', () => {
    expect(scrubTelemetry({ retries: 3, ok: true, missing: null })).toEqual({
      retries: 3,
      ok: true,
      missing: null,
    });
  });
});

describe('scrubText', () => {
  it('cobre os padrões individuais de conteúdo', () => {
    expect(scrubText('token ghp_abcdefghijklmnopqrst1234')).toBe(`token ${TELEMETRY_REDACTED}`);
    expect(scrubText('usou Bearer abc.def-ghi_jkl12345')).toBe(`usou Bearer ${TELEMETRY_REDACTED}`);
    expect(scrubText('jwt eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2ln')).toBe(`jwt ${TELEMETRY_REDACTED}`);
    expect(scrubText('url ?password=hunter2&page=2')).toBe(
      `url ?password=${TELEMETRY_REDACTED}&page=2`,
    );
    expect(scrubText('postgres://stakeframe:senha123@db:5432/stake')).toBe(
      `postgres://stakeframe:${TELEMETRY_REDACTED}@db:5432/stake`,
    );
    expect(scrubText('mail to someone@example.org now')).toBe(`mail to ${TELEMETRY_REDACTED} now`);
    expect(scrubText('id 5511999998888 fim')).toBe(`id ${TELEMETRY_REDACTED} fim`);
    expect(scrubText(`prefixo ${'a'.repeat(3000)}`).length).toBeLessThanOrEqual(2048);
  });
});

describe('sanitizeLogText', () => {
  it('colapsa espaços e limita o tamanho', () => {
    expect(sanitizeLogText('linha   com\nquebras\t demais')).toBe('linha com quebras demais');
    expect(sanitizeLogText('x'.repeat(5000)).length).toBe(1024);
  });
});
