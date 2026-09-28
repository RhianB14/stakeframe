import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseTelegramCallbackData,
  telegramArchiveListSchema,
  telegramPreviewActionResultSchema,
  telegramPreviewActionSchema,
  telegramTicketPreviewSchema,
  type TelegramTicketPreview,
} from '../../packages/shared/src/index.js';
import {
  telegramTicketContext,
  telegramTicketIdentity,
} from '../../packages/db/src/telegram-ticket.js';
import { buildPreviewMessage } from '../../apps/worker/src/telegram-preview-message.js';
import { telegramPreviewButtons } from '../../apps/worker/src/telegram.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const image = sha('synthetic-ticket-bytes');

/**
 * STK-F2-05 §15 — identidade determinística da duplicata.
 *
 * A regra tem de sobreviver ao reenvio: a MESMA foto com o MESMO contexto é
 * duplicata mesmo com outra mensagem e outro horário, e a foto igual com
 * contexto diferente NÃO é.
 */
describe('STK-F2-05 — identidade determinística da imagem + contexto', () => {
  it('reconhece a mesma imagem e o mesmo contexto como a mesma identidade', () => {
    const first = telegramTicketIdentity(image, telegramTicketContext('Tipster Fictício\nBet365'));
    // Reenvio: outra mensagem, outro instante, mesma foto e legenda.
    const resent = telegramTicketIdentity(image, telegramTicketContext('Tipster Fictício\nBet365'));
    expect(resent).toBe(first);
  });

  it('ignora a forma da legenda (maiúsculas, acentos, espaços extras)', () => {
    const canonical = telegramTicketIdentity(
      image,
      telegramTicketContext('Tipster Fictício\nBet365'),
    );
    const messy = telegramTicketIdentity(
      image,
      telegramTicketContext('  TIPSTER   FICTÍCIO \n\n  bet365  '),
    );
    expect(messy).toBe(canonical);
  });

  it('separa contextos diferentes: mesma foto, contexto distinto não é duplicata', () => {
    const base = telegramTicketIdentity(image, telegramTicketContext('Tipster A\nBet365'));
    const other = telegramTicketIdentity(image, telegramTicketContext('Tipster B\nBet365'));
    const otherHouse = telegramTicketIdentity(image, telegramTicketContext('Tipster A\nSuperbet'));
    expect(other).not.toBe(base);
    expect(otherHouse).not.toBe(base);
  });

  it('separa imagens diferentes com o mesmo contexto', () => {
    const first = telegramTicketIdentity(image, 'Bet365|Fixture');
    const second = telegramTicketIdentity(sha('outra-imagem'), 'Bet365|Fixture');
    expect(second).not.toBe(first);
  });

  it('separa campos equivalentes que sem separador colidiriam', () => {
    // A identidade concatena imagem + contexto: sem separador, ("ab","c") e
    // ("a","bc") seriam o mesmo bilhete.
    const left = telegramTicketIdentity(sha('ab'), 'c');
    const right = telegramTicketIdentity(sha('a'), 'bc');
    expect(left).not.toBe(right);
  });

  it('recusa um sha256 que não é hexadecimal de 64 dígitos', () => {
    expect(() => telegramTicketIdentity('nao-e-um-hash', 'x')).toThrow('TELEGRAM_TICKET_DUPLICATE');
  });
});

/** O contrato do preview recusa qualquer tentativa de inventar campo. */
describe('STK-F2-05 — contrato do preview estruturado', () => {
  const base: TelegramTicketPreview = {
    id: '11111111-1111-4111-8111-111111111111',
    version: 3,
    state: 'review',
    queueState: 'preview',
    sentAt: '2026-09-28T12:00:00.000Z',
    eventAt: null,
    eventDateStatus: 'pending',
    bookmaker: 'Bet365',
    tipster: 'Fixture',
    stake: '100.00',
    odds: '2.00',
    reference: 'ABC-123',
    kind: 'simple',
    origin: 'real',
    selections: [
      {
        event: 'Aurora x Central',
        sport: 'Futebol',
        market: 'Vencedor',
        selection: 'Aurora',
        odds: null,
      },
    ],
    potentialReturn: '200.00',
    duplicate: { detected: false, ofImportId: null, reasons: [] },
    archive: { archived: false, reason: null, recoverableUntil: null, restored: false },
    actions: ['confirm', 'edit', 'discard'],
    blockedReason: null,
  };

  it('aceita o preview com a data do evento separada da data de envio', () => {
    expect(telegramTicketPreviewSchema.parse(base)).toMatchObject({
      sentAt: '2026-09-28T12:00:00.000Z',
      eventAt: null,
      eventDateStatus: 'pending',
    });
  });

  it('aceita preview terminal, sem ação de lançamento disponível', () => {
    // Duplicata e arquivado são terminais: o preview continua legível, mas não
    // oferece confirmar — é o que impede um segundo lançamento por reenvio.
    expect(
      telegramTicketPreviewSchema.parse({
        ...base,
        state: 'discarded',
        actions: [],
        archive: {
          archived: true,
          reason: 'duplicate',
          recoverableUntil: '2026-10-28T12:00:00.000Z',
          restored: false,
        },
      }),
    ).toMatchObject({ actions: [] });
  });

  it('recusa motivo de duplicata fora do conjunto conhecido', () => {
    expect(() =>
      telegramTicketPreviewSchema.parse({
        ...base,
        duplicate: { detected: true, ofImportId: null, reasons: ['timestamp'] },
      }),
    ).toThrow();
  });

  it('aceita somente decisões explícitas: confirmar, descartar ou reprocessar', () => {
    for (const decision of ['confirm', 'discard', 'retry']) {
      expect(telegramPreviewActionSchema.parse({ version: 2, decision })).toEqual({
        version: 2,
        decision,
      });
    }
    // Não existe "auto" nem "desfazer temporizado".
    expect(() => telegramPreviewActionSchema.parse({ version: 2, decision: 'auto' })).toThrow();
    expect(() =>
      telegramPreviewActionSchema.parse({ version: 2, decision: 'undo', afterSeconds: 30 }),
    ).toThrow();
  });

  it('recusa o resultado de decisão sem prazo de recuperação coerente', () => {
    expect(
      telegramPreviewActionResultSchema.parse({
        id: base.id,
        version: 4,
        state: 'discarded',
        betId: null,
        restored: false,
        recoverableUntil: '2026-10-28T12:00:00.000Z',
      }),
    ).toMatchObject({ restored: false });
  });

  it('limita a lista de arquivos e exige identidade hexadecimal', () => {
    expect(
      telegramArchiveListSchema.parse({
        items: [
          {
            archiveId: '22222222-2222-4222-8222-222222222222',
            importId: base.id,
            identity: image,
            reason: 'discarded',
            archivedAt: '2026-09-28T12:00:00.000Z',
            recoverableUntil: '2026-10-28T12:00:00.000Z',
          },
        ],
      }).items,
    ).toHaveLength(1);
    expect(() =>
      telegramArchiveListSchema.parse({
        items: [
          {
            archiveId: '22222222-2222-4222-8222-222222222222',
            importId: base.id,
            identity: 'nao-e-hex',
            reason: 'discarded',
            archivedAt: '2026-09-28T12:00:00.000Z',
            recoverableUntil: '2026-10-28T12:00:00.000Z',
          },
        ],
      }),
    ).toThrow();
  });
});

/** §15 — preview obrigatório: a mensagem diz que nada foi lançado. */
describe('STK-F2-05 — mensagem de preview antes de qualquer lançamento', () => {
  const preview: TelegramTicketPreview = {
    id: '11111111-1111-4111-8111-111111111111',
    version: 3,
    state: 'review',
    queueState: 'preview',
    sentAt: '2026-09-28T12:00:00.000Z',
    eventAt: null,
    eventDateStatus: 'pending',
    bookmaker: 'Bet365',
    tipster: 'Fixture',
    stake: '100.00',
    odds: '2.00',
    reference: 'ABC-123',
    kind: 'simple',
    origin: 'real',
    selections: [
      {
        event: 'Aurora x Central',
        sport: 'Futebol',
        market: 'Vencedor',
        selection: 'Aurora',
        odds: null,
      },
    ],
    potentialReturn: '200.00',
    duplicate: { detected: false, ofImportId: null, reasons: [] },
    archive: { archived: false, reason: null, recoverableUntil: null, restored: false },
    actions: ['confirm', 'edit', 'discard'],
    blockedReason: null,
  };

  const row = { chatId: 42, sourceMessageId: 10, processingMessageId: 11 };

  it('abre deixando claro que nenhuma escrita financeira aconteceu', () => {
    const text = buildPreviewMessage({ preview, ...row });
    expect(text).toContain('PREVIEW');
    expect(text).toContain('nada foi lançado ainda');
    expect(text).toContain('Confirmar');
    expect(text).toContain('Editar');
    expect(text).toContain('Descartar');
  });

  it('separa a data de envio da data do evento, sem inferir uma da outra', () => {
    const text = buildPreviewMessage({ preview, ...row });
    // A data de envio é o instante da mensagem original.
    expect(text).toMatch(/📅 Enviado em: 28\/09\/2026/);
    // A data do evento nasce pendente e pede declaração explícita.
    expect(text).toContain('🎮 Evento em: pendente');
    expect(text).not.toMatch(/🎮 Evento em: 28\/09\/2026/);
  });

  it('mostra a data do evento quando ela foi declarada, sem tocar na de envio', () => {
    const confirmed = buildPreviewMessage({
      ...row,
      preview: {
        ...preview,
        eventAt: '2026-10-05T19:00:00.000Z',
        eventDateStatus: 'confirmed',
      },
    });
    expect(confirmed).toMatch(/📅 Enviado em: 28\/09\/2026/);
    expect(confirmed).toMatch(/🎮 Evento em: 05\/10\/2026/);
  });

  it('avisa sobre possível duplicata por identidade da imagem', () => {
    const text = buildPreviewMessage({
      ...row,
      preview: {
        ...preview,
        duplicate: {
          detected: true,
          ofImportId: '33333333-3333-4333-8333-333333333333',
          reasons: ['image'],
        },
      },
    });
    expect(text).toContain('duplicata');
    expect(text).toContain('mesma imagem e contexto');
  });

  it('anuncia a janela de recuperação de 30 dias ao arquivar', () => {
    const text = buildPreviewMessage({
      ...row,
      preview: {
        ...preview,
        state: 'discarded',
        actions: [],
        archive: {
          archived: true,
          reason: 'discarded',
          recoverableUntil: '2026-10-28T12:00:00.000Z',
          restored: false,
        },
      },
    });
    expect(text).toContain('Recuperável até');
  });

  it('oferece retry quando a extração falhou', () => {
    const text = buildPreviewMessage({
      ...row,
      preview: {
        ...preview,
        state: 'failed',
        actions: ['edit', 'discard', 'retry'],
        blockedReason: 'EXTRACTION_FAILED',
      },
    });
    expect(text).toContain('Retry');
  });

  it('não sugere confirmação quando faltam valor e odd', () => {
    const text = buildPreviewMessage({
      ...row,
      preview: { ...preview, stake: null, blockedReason: 'FIELDS_PENDING' },
    });
    expect(text).toContain('Faltam valor e odd');
  });
});

/** §15 — a decisão chega por callback próprio, sem identificador no payload. */
describe('STK-F2-05 — teclado e callbacks do preview', () => {
  it('oferece confirmar, editar e descartar sem carregar o id no payload', () => {
    const buttons = telegramPreviewButtons(
      'https://app.stakeframe.test/#miniapp',
      '11111111-1111-4111-8111-111111111111',
    );
    const payloads = buttons
      .flat()
      .map((button) => ('callback_data' in button ? button.callback_data : null))
      .filter((payload): payload is string => payload !== null);
    expect(payloads).toEqual(['sf:v1:preview:confirm', 'sf:v1:preview:discard']);
    // Nenhum payload carrega o id da importação: a resolução é pelo chat + id
    // da mensagem, como em toda a STK-G0-20.
    for (const payload of payloads) expect(payload).not.toContain('1111');
  });

  it('o botão Editar abre o Mini App por HTTPS com o UUID opaco', () => {
    const buttons = telegramPreviewButtons(
      'https://app.stakeframe.test/#miniapp',
      '11111111-1111-4111-8111-111111111111',
    );
    const edit = buttons.flat().find((button) => button.text === '✏️ Editar');
    expect(edit && 'web_app' in edit ? edit.web_app.url : null).toBe(
      'https://app.stakeframe.test/miniapp#miniapp?import=11111111-1111-4111-8111-111111111111',
    );
  });

  it.each([
    ['sf:v1:preview:confirm', 'preview_confirm'],
    ['sf:v1:preview:discard', 'preview_discard'],
    ['sf:v1:preview', 'preview'],
  ])('reconhece o callback %s como %s', (data, action) => {
    expect(parseTelegramCallbackData(data)?.action).toBe(action);
  });

  it('recusa callback de preview com identificador no payload', () => {
    expect(parseTelegramCallbackData('sf:v1:preview:confirm:11111111-1111-4111-8111')).toBeNull();
  });
});
