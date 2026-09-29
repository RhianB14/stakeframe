import { describe, expect, it, vi } from 'vitest';
import {
  TELEGRAM_COMMANDS,
  TELEGRAM_TEXT_MAX,
  TELEGRAM_TEXT_MIN,
  parseTelegramIntent,
  telegramPeriod,
  telegramTextIsWithinBounds,
} from '../../packages/shared/src/index.js';
import {
  authorizedText,
  telegramPreviewButtons,
  telegramTextConfirmButtons,
  type TelegramConfig,
} from '../../apps/worker/src/telegram.js';
import { textBetDraftSchema, TELEGRAM_TEXT_ERROR_CODES } from '../../packages/shared/src/index.js';
import {
  TEXT_REGISTRATION_SYSTEM_PROMPT,
  readTextBet,
} from '../../apps/worker/src/telegram-text-reader.js';

/**
 * STK-F2-07 §15 (unit) — o contrato do texto, antes de qualquer banco.
 *
 * São as regras que protegem o dinheiro e que a integração não conseguiria
 * provar sozinha, porque não têm banco: o conjunto fechado de comandos, a
 * propriedade do deep link, a recusa do texto fora da janela, a sanitização por
 * ausência de campo e o teto da mensagem.
 */

const config: TelegramConfig = {
  token: '123456:synthetic-token-not-a-real-credential',
  userId: '999',
  chatId: '999',
  miniAppUrl: 'https://app.stakeframe.test',
};
const json = (body: unknown, status = 200) => Response.json(body, { status });

describe('STK-F2-07: o conjunto fechado de comandos', () => {
  it('é exatamente os onze do card, sem nenhum a mais', () => {
    expect([...TELEGRAM_COMMANDS]).toEqual([
      'hoje',
      'semana',
      'mes',
      'banca',
      'pendentes',
      'fila',
      'exportar',
      'relatorio',
      'casa',
      'tipster',
      'config',
    ]);
  });

  it.each(TELEGRAM_COMMANDS)('reconhece /%s como comando', (command) => {
    expect(parseTelegramIntent(`/${command}`)).toEqual({ kind: 'command', command });
  });

  it('aceita o comando com menção ao bot e com caixa diferente', () => {
    expect(parseTelegramIntent('/HOJE@stakeframe_bot')).toEqual({
      kind: 'command',
      command: 'hoje',
    });
    expect(parseTelegramIntent('  /fila  ')).toEqual({ kind: 'command', command: 'fila' });
  });

  it('recusa uma barra que não está na lista, sem cair em texto livre', () => {
    // A distinção é o que importa: um comando desconhecido é `unknown-command`,
    // nunca `free-text` — o usuário pediu um comando, não pediu para registrar.
    expect(parseTelegramIntent('/apostar')).toEqual({ kind: 'unknown-command' });
    expect(parseTelegramIntent('/undo')).toEqual({ kind: 'unknown-command' });
  });

  it('NUNCA trata o deep link da F2-04 como texto', () => {
    // `null` é o sinal do roteador: a mensagem pertence ao vínculo. Se o
    // classificador a devolvesse como texto, o worker tentaria ler um token de
    // uso único como se fosse uma aposta.
    expect(parseTelegramIntent('/start')).toBeNull();
    expect(parseTelegramIntent('/start@stakeframe_bot')).toBeNull();
    expect(parseTelegramIntent('/start AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
  });

  it('trata qualquer outra mensagem como texto livre', () => {
    expect(parseTelegramIntent('apostei 50 reais na bet365 odd 2.50')).toEqual({
      kind: 'free-text',
    });
  });

  it('ignora mensagem vazia ou só com espaços', () => {
    expect(parseTelegramIntent('')).toBeNull();
    expect(parseTelegramIntent('   \n  ')).toBeNull();
  });
});

describe('STK-F2-07: a janela do texto livre', () => {
  it('aceita dentro da janela e recusa fora dela, antes de qualquer chamada', () => {
    expect(telegramTextIsWithinBounds('a'.repeat(TELEGRAM_TEXT_MIN))).toBe(true);
    expect(telegramTextIsWithinBounds('a'.repeat(TELEGRAM_TEXT_MAX))).toBe(true);
    expect(telegramTextIsWithinBounds('a'.repeat(TELEGRAM_TEXT_MIN - 1))).toBe(false);
    expect(telegramTextIsWithinBounds('a'.repeat(TELEGRAM_TEXT_MAX + 1))).toBe(false);
  });
});

describe('STK-F2-07: as janelas de período', () => {
  // 2026-03-18T12:00:00Z é quarta-feira, 18 de março de 2026, em São Paulo.
  const now = new Date('2026-03-18T12:00:00Z');

  it('/hoje é um dia só, e /semana são sete dias fechados nele', () => {
    expect(telegramPeriod('hoje', now)).toEqual({
      command: 'hoje',
      from: '2026-03-18',
      to: '2026-03-18',
    });
    expect(telegramPeriod('semana', now)).toEqual({
      command: 'semana',
      from: '2026-03-12',
      to: '2026-03-18',
    });
  });

  it('/mes vai do primeiro dia do mês até hoje — nunca até o fim do mês', () => {
    // Uma janela que incluísse o futuro somaria eventos que ainda não
    // aconteceram, e o número pareceria menor do que é.
    expect(telegramPeriod('mes', now)).toEqual({
      command: 'mes',
      from: '2026-03-01',
      to: '2026-03-18',
    });
  });

  it('corta pela data de São Paulo, não pela data UTC', () => {
    // 2026-03-18T01:00:00Z ainda é 17 de março em São Paulo (UTC-3).
    expect(telegramPeriod('hoje', new Date('2026-03-18T01:00:00Z'))).toEqual({
      command: 'hoje',
      from: '2026-03-17',
      to: '2026-03-17',
    });
  });
});

describe('STK-F2-07: a fronteira de texto autorizado', () => {
  const update = (text: string, over: Record<string, unknown> = {}) => ({
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      from: { id: 999, is_bot: false },
      chat: { id: 999, type: 'private' },
      text,
      ...over,
    },
  });

  it('aceita a mensagem de texto do remetente autorizado e devolve a data original', () => {
    const parsed = authorizedText(update('/hoje'), config);
    expect(parsed).toMatchObject({ messageId: 10, text: '/hoje' });
    // A data é o instante da MENSAGEM ORIGINAL: é o `placedAt` do bilhete
    // textual, nunca o relógio do servidor.
    expect(parsed?.receivedAt.toISOString()).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });

  it('recusa usuário, chat e texto alheios sem tocar nada', () => {
    expect(
      authorizedText(update('/hoje', { from: { id: 123, is_bot: false } }), config),
    ).toBeNull();
    expect(
      authorizedText(update('/hoje', { chat: { id: 42, type: 'private' } }), config),
    ).toBeNull();
    expect(authorizedText(update('   '), config)).toBeNull();
  });
});

describe('STK-F2-07: a sanitização do rascunho textual', () => {
  const valid = {
    reference: 'ABC123',
    stake: '50.00',
    odds: '2.50',
    bookmakerName: 'Bet365',
    tipsterName: null,
    selections: [{ event: null, sport: null, market: 'Vitória', selection: 'Alfa', odds: null }],
    warnings: [],
  };

  it('aceita a estrutura dentro do contrato', () => {
    expect(textBetDraftSchema.safeParse(valid).success).toBe(true);
  });

  it('REJEITA casa resolvida pelo modelo (o campo não existe no contrato)', () => {
    // A casa é declaração do usuário e chega pelo catálogo; um id de casa vindo
    // do texto é exatamente o que a STK-G0-22 já vetou para a imagem.
    const result = textBetDraftSchema.safeParse({ ...valid, bookmakerId: 'qualquer-coisa' });
    expect(result.success).toBe(false);
  });

  it('REJEITA origem financeira, data, retorno e recomendação', () => {
    for (const extra of [
      { betOrigin: 'freebet' },
      { eventAt: '2026-03-18T00:00:00Z' },
      { potentialReturn: '125.00' },
      { recommendation: 'vale a pena' },
      { analysis: 'essa aposta é boa' },
    ]) {
      expect(textBetDraftSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
  });

  it('REJEITA texto bruto do fornecedor em qualquer nível', () => {
    expect(
      textBetDraftSchema.safeParse({ ...valid, rawResponse: 'conteúdo', content: 'conteúdo' })
        .success,
    ).toBe(false);
    expect(
      textBetDraftSchema.safeParse({
        ...valid,
        selections: [{ ...valid.selections[0], raw: 'conteúdo' }],
      }).success,
    ).toBe(false);
  });

  it('rejeita valor e odd fora do que o dinheiro e a odd aceitam', () => {
    expect(textBetDraftSchema.safeParse({ ...valid, stake: '0' }).success).toBe(false);
    expect(textBetDraftSchema.safeParse({ ...valid, odds: '0.5' }).success).toBe(false);
    expect(textBetDraftSchema.safeParse({ ...valid, stake: 'cinquenta' }).success).toBe(false);
  });

  it('os códigos de erro são um conjunto FECHADO e nenhum carrega texto', () => {
    for (const code of TELEGRAM_TEXT_ERROR_CODES) expect(code).toMatch(/^TELEGRAM_TEXT_[A-Z_]+$/);
  });
});

describe('STK-F2-07: o prompt de leitura', () => {
  it('proíbe explicitamente as quatro coisas que o card proíbe', () => {
    // Não basta o schema não ter o campo: o prompt precisa não convidar, porque
    // o campo ausente impede a persistência e o prompt previne o desperdício de
    // uma chamada paga para o modelo inventar algo que será descartado.
    expect(TEXT_REGISTRATION_SYSTEM_PROMPT).toContain('[Cálculo]');
    expect(TEXT_REGISTRATION_SYSTEM_PROMPT).toContain('[Opinião]');
    expect(TEXT_REGISTRATION_SYSTEM_PROMPT).toContain('[Datas]');
    expect(TEXT_REGISTRATION_SYSTEM_PROMPT).toContain('[Origem financeira]');
  });
});

describe('STK-F2-07: o leitor na fronteira da chamada paga', () => {
  const apiKey = `sk-or-v1-${'a'.repeat(64)}`;
  const completion = (content: unknown) =>
    json({
      id: 'f2-07-test',
      model: 'google/gemini-3.8-flash',
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

  it('devolve a estrutura validada e o texto NUNCA é devolvido', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      completion({
        reference: 'ABC123',
        stake: '50.00',
        odds: '2.50',
        bookmakerName: 'Bet365',
        tipsterName: null,
        selections: [
          { event: null, sport: null, market: 'Vitória', selection: 'Alfa', odds: null },
        ],
        warnings: [],
      }),
    );
    const result = await readTextBet({ apiKey, text: 'minha aposta secreta', fetchImpl });
    expect(result.draft.stake).toBe('50.00');
    expect(result.model).toBe('google/gemini-3.8-flash');
    // O texto aparece no corpo da requisição (é o input) e em nenhum campo do
    // retorno — o retorno é a estrutura, o modelo e o tempo.
    expect(JSON.stringify(result.draft)).not.toContain('minha aposta secreta');
  });

  it('recusa a resposta com campo fora do contrato, sem devolve-lo', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        completion({ reference: null, stake: '1.00', odds: '2.00', bookmakerId: 'x' }),
      );
    await expect(readTextBet({ apiKey, text: 'texto', fetchImpl })).rejects.toMatchObject({
      code: 'AI_EXTRACTION_INVALID',
    });
  });

  it('classifica a falha pelo código, sem vazar resposta do fornecedor', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: { message: 'segredo do provedor' } }, 401));
    await expect(readTextBet({ apiKey, text: 'texto', fetchImpl })).rejects.toMatchObject({
      code: 'AI_AUTH_REFUSED',
    });
  });
});

describe('STK-F2-07: o teclado da decisão', () => {
  it('o registro por texto usa o MESMO teclado do preview da F2-05', () => {
    // Um rascunho textual e um de foto são a MESMA decisão; dois teclados
    // criariam dois caminhos de escrita financeira onde o produto tem um.
    expect(telegramTextConfirmButtons('https://app.stakeframe.test', 'id-1')).toEqual(
      telegramPreviewButtons('https://app.stakeframe.test', 'id-1'),
    );
  });

  it('Confirmar e Descartar são callbacks sem identificador no payload', () => {
    const buttons = telegramTextConfirmButtons('https://app.stakeframe.test', 'id-1');
    const payloads = buttons
      .flat()
      .map((button) => (button as { callback_data?: string }).callback_data);
    expect(payloads.filter(Boolean)).toEqual(['sf:v1:preview:confirm', 'sf:v1:preview:discard']);
    // Editar abre o Mini App pelo UUID opaco, e só ele.
    const webApp = buttons.flat().find((button) => 'web_app' in button) as {
      web_app: { url: string };
    };
    expect(webApp.web_app.url).toBe('https://app.stakeframe.test/miniapp#miniapp?import=id-1');
  });
});
