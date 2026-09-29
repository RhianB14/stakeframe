import { z } from 'zod';
import { saoPauloDate } from './decimal.js';

/**
 * STK-F2-07 — os onze comandos do Telegram e a fronteira da mensagem de texto.
 *
 * Este arquivo é a CONTRATO de parsing, e ele é puro: nenhuma consulta, nenhuma
 * escrita, nenhuma chamada de IA. Ele existe para que a decisão "isto é um
 * comando, isto é texto livre, isto é um deep link" seja testável sozinha —
 * porque essa decisão é a que impede um texto de usuário de virar escrita
 * financeira sem passar pela confirmação.
 *
 * Três regras estruturais:
 *
 *  1) O conjunto é FECHADO. `/hoje` … `/config` são os onze do card; qualquer
 *     outra barra é `unknown`, nunca um comando novo. A lista não cresce por
 *     conveniência: cada linha é uma superfície que precisa de teste, de
 *     confirmação e de limite.
 *
 *  2) `/start` NÃO É COMANDO. O deep link de uso único da STK-F2-04 é
 *     propriedade dele: devolver `null` é o que faz o roteador entregar a
 *     mensagem ao vínculo, em vez de tratá-la como texto livre. Um texto que
 *     começa com `/` mas não é da lista é `unknown` — e `unknown` nunca vira
 *     texto livre, porque o usuário disse "comando" e não "registre isto".
 *
 *  3) O TEXTO LIVRE É DELIMITADO. Acima do limite a mensagem é recusada com
 *     orientação, sem chamada de IA: a cota da STK-F2-06 é por apresentação e
 *     texto sem teto é uma forma barata de gastá-la.
 */

/** Os onze comandos do card STK-F2-07, na ordem do Plano §8.2. */
export const TELEGRAM_COMMANDS = [
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
] as const;
export const telegramCommandSchema = z.enum(TELEGRAM_COMMANDS);
export type TelegramCommand = z.infer<typeof telegramCommandSchema>;

/**
 * Texto aceito como registro em linguagem natural. O teto é o mesmo da legenda
 * (`caption` tem 1024 na fronteira da foto): é a mesma superfície de contexto,
 * com o mesmo teto.
 */
export const TELEGRAM_TEXT_MAX = 1024;
/** Abaixo disto não há aposta a extrair — e não vale consumir cota. */
export const TELEGRAM_TEXT_MIN = 12;

export type TelegramIntent =
  | { kind: 'command'; command: TelegramCommand }
  | { kind: 'unknown-command' }
  | { kind: 'free-text' };

/**
 * Decide o destino de uma mensagem de texto.
 *
 * `null` significa "não é desta fronteira": é o deep link `/start`, que o
 * roteador entrega à STK-F2-04. Texto vazio ou só com espaços é `null` também —
 * não há nada a decidir, e o worker não responde a silêncio.
 */
export function parseTelegramIntent(text: string): TelegramIntent | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) {
    // `/start` e `/start@bot` são do vínculo; os dois com e sem payload.
    if (/^\/start(@\S+)?(\s|$)/.test(trimmed)) return null;
    const name = trimmed.slice(1).split(/[\s@]/, 1)[0]!.toLocaleLowerCase('pt-BR');
    const parsed = telegramCommandSchema.safeParse(name);
    return parsed.success ? { kind: 'command', command: parsed.data } : { kind: 'unknown-command' };
  }
  return { kind: 'free-text' };
}

/** Recusa o texto fora da janela útil, antes de qualquer chamada paga. */
export function telegramTextIsWithinBounds(text: string): boolean {
  const length = text.trim().length;
  return length >= TELEGRAM_TEXT_MIN && length <= TELEGRAM_TEXT_MAX;
}

/**
 * Períodos nomeados, já fechados em datas de São Paulo.
 *
 * A data é derivada de um instante INJETADO (o relógio do servidor no uso real)
 * e nunca do texto: a janela é um recorte do relatório, não uma declaração do
 * usuário. `hoje` é um dia, `semana` são sete e `mes` é o mês corrente até hoje
 * — nenhum deles é uma janela móvel "últimas 24 horas", porque o relatório
 * trabalha por data de evento em São Paulo e as duas bases não conversam.
 */
export type TelegramPeriod = {
  command: 'hoje' | 'semana' | 'mes';
  from: string;
  to: string;
};

export function telegramPeriod(command: TelegramPeriod['command'], now: Date): TelegramPeriod {
  const today = saoPauloDate(now);
  if (command === 'hoje') return { command, from: today, to: today };
  if (command === 'semana') {
    const start = new Date(`${today}T12:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 6);
    return { command, from: saoPauloDate(start), to: today };
  }
  return { command, from: `${today.slice(0, 7)}-01`, to: today };
}
