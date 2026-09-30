import { betTableColumns, type BetTableColumnKey } from '@stakeframe/shared';

/* Reexportado porque o painel e a página importam a chave daqui, junto com
   as listas: quem decide o que é visível precisa das duas coisas. */
export type { BetTableColumnKey };

/**
 * STK-F2-18 (Fase 3) — quais das 14 colunas da tabela de apostas aparecem.
 *
 * A tabela tem 14 colunas aprovadas pelo proprietário e é o pior caso de
 * densidade do produto: 1640px de largura mínima contra ~1100px úteis na
 * sidebar de 248px. Antes desta fase a única forma de ver a coluna 12 era
 * rolar horizontalmente, e a dica de rolagem era texto estático.
 *
 * Duas decisões:
 *
 * 1. O conjunto PADRÃO é menor que o conjunto completo, e é uma escolha de
 *    produto, não de gosto: quem abre a tela precisa ver situação, valor,
 *    retorno e resultado sem rolar nada. Evento, seleção e casa vêm logo
 *    depois porque são o contexto que transforma um número em aposta.
 *    `gameTime`, `market` e `ticketKind` são derivado de outra coluna —
 *    horário está em "Data do jogo", mercado e tipo estão no detalhe.
 * 2. A preferência é persistida por workspace + usuário. É preferência de
 *    leitura, e um painel de colunas que se esquece a cada recarga é
 *    decoração, não ferramenta.
 *
 * A ordem das colunas NÃO é configurável: `betTableColumns` é a ordem
 * aprovada pelo dono (STK-BETS-02) e a interface não pode reordená-la. O
 * painel escolhe quais aparecem, nunca em que ordem.
 */

const STORAGE_KEY = 'stakeframe.bet-columns.v1';

/** Colunas visíveis sem nenhuma configuração. Ver o comentário acima. */
export const DEFAULT_BET_COLUMNS: readonly BetTableColumnKey[] = [
  'ticket',
  'gameDate',
  'event',
  'bookmaker',
  'stake',
  'odds',
  'return',
  'result',
];

/**
 * Colunas que não podem ser escondidas. `ticket` identifica o registro e
 * `result` diz o que aconteceu com ele — sem os dois, a tabela deixa de
 * ser uma tabela de apostas e vira uma lista de números sem dono.
 */
export const REQUIRED_BET_COLUMNS: readonly BetTableColumnKey[] = ['ticket', 'result'];

/** Toda coluna, na ordem aprovada. O painel itera esta lista. */
export const ALL_BET_COLUMNS = betTableColumns;

/**
 * Lê a preferência persistida. Qualquer estado inválido (chave corrompida,
 * coluna que não existe mais, lista vazia, coluna obrigatória escondida)
 * cai no conjunto padrão em vez de quebrar a tela — a lista completa
 * sempre está disponível, então nunca há estado sem saída.
 */
export function readBetColumns(
  owner: string,
  storage: Pick<Storage, 'getItem'> | null | undefined,
): BetTableColumnKey[] {
  const fallback = () => [...DEFAULT_BET_COLUMNS];
  if (!storage) return fallback();
  try {
    const raw = storage.getItem(`${STORAGE_KEY}.${owner}`);
    if (!raw) return fallback();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback();
    const known = new Set<string>(ALL_BET_COLUMNS.map((column) => column.key as string));
    const keys = parsed.filter((key): key is string => typeof key === 'string');
    // Chave desconhecida = preferência corrompida (catálogo antigo, edição
    // manual, storage de outro formato). Não é o mesmo que "desmarquei
    // tudo": os dois casos precisam ser distinguidos, senão um lixão no
    // storage apaga a tabela e a pessoa perde as 8 colunas sem explicação.
    if (keys.length !== parsed.length || keys.some((key) => !known.has(key))) return fallback();
    // Lista vazia é lixo: o painel sempre inclui as obrigatórias ao gravar,
    // então `[]` só sai de storage corrompido — não de uma escolha.
    if (!keys.length) return fallback();
    const requested = keys.filter(
      (key): key is BetTableColumnKey => !REQUIRED_BET_COLUMNS.includes(key as BetTableColumnKey),
    );
    // A ordem do painel é livre; a ordem da tabela é a aprovada. Ordena
    // pelo catálogo para que a preferência nunca desalinhe a tabela.
    const visible = ALL_BET_COLUMNS.map((column) => column.key).filter(
      (key) => REQUIRED_BET_COLUMNS.includes(key) || requested.includes(key),
    );
    // Só as obrigatórias é um estado limite VÁLIDO (a pessoa desmarcou as
    // opcionais de propósito). Lista vazia, essa sim, é lixo.
    return visible.length ? visible : fallback();
  } catch {
    return fallback();
  }
}

/** Grava a preferência. Falha de quota é silenciosa por desenho. */
export function writeBetColumns(
  owner: string,
  columns: readonly BetTableColumnKey[],
  storage: Pick<Storage, 'setItem'> | null | undefined,
) {
  if (!storage) return;
  try {
    storage.setItem(`${STORAGE_KEY}.${owner}`, JSON.stringify([...columns]));
  } catch {
    /* private mode / cota cheia: a preferência vale só nesta sessão */
  }
}
