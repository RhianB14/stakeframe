import { parseCaption, renderImportMessage, ticketExtractionSchema } from '@stakeframe/shared';

// STK-G0-19-R5 — mensagem final do bot a partir do registro canônico.
// Enquanto eventAt não foi confirmado, exibe telegramReceivedAt como valor
// provisório; o retorno potencial é calculado (stake × odds, aritmética
// decimal exata) e o valor visual é apenas diagnóstico.

const STATUS_LABELS: Record<string, string> = {
  pending: 'Bilhete recebido — em processamento',
  processing: 'Bilhete recebido — em processamento',
  review: 'Bilhete analisado — aguardando confirmação',
  failed: 'Não conseguimos processar o bilhete',
  discarded: 'Importação descartada',
  imported: 'Aposta registrada',
};

const instantFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'short',
  timeStyle: 'short',
});

const formatInstant = (value: string | Date | null) =>
  value === null ? null : instantFormat.format(new Date(value));

// stake (até 2 casas) × odds (até 4 casas) com arredondamento half-up em centavos.
export function grossReturn(stake: string, odds: string): string | null {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(stake) || !/^\d{1,12}(\.\d{1,4})?$/.test(odds)) return null;
  const scale = (value: string, decimals: number) => {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(`${fraction}0000`.slice(0, decimals));
  };
  const cents = scale(stake, 2);
  const scaledOdds = scale(odds, 4);
  const total = (cents * scaledOdds + 5000n) / 10000n;
  const whole = total / 100n;
  const fraction = (total % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

// STK-G0-19-R8 — dados canônicos da aposta importada (finance.bet/selection):
// depois da importação a mensagem NÃO usa legenda/OCR como fonte prioritária.
export type CanonicalBetData = {
  state: string;
  bookmaker: string | null;
  tipster: string | null;
  origin: 'real' | 'freebet';
  stake: string;
  odds: string;
  placedAt: Date | null;
  selections: {
    event: string | null;
    market: string | null;
    selection: string | null;
    eventAt: Date | null;
    dateStatus: string;
  }[];
};

export type ImportMessageRow = {
  id: string;
  state: string;
  caption: string;
  extraction: unknown;
  bet_origin: string | null;
  event_at: Date | null;
  event_date_status: string;
  telegram_received_at: Date | null;
  /** Casa declarada no rascunho (seção "Alterar Casa"), quando houver. */
  override_bookmaker?: string | null;
  /** Presente quando a importação já tem aposta registrada. */
  canonical?: CanonicalBetData | null;
};

export function buildImportMessage(row: ImportMessageRow): string {
  const labels = parseCaption(row.caption);
  const evidence =
    row.extraction && typeof row.extraction === 'object' && 'extraction' in row.extraction
      ? (row.extraction as { extraction: unknown }).extraction
      : row.extraction;
  const parsed = ticketExtractionSchema.safeParse(evidence);
  const extraction = parsed.success ? parsed.data : null;
  if (row.canonical) {
    // R8 — pós-importação: os dados vêm integralmente das tabelas
    // financeiras canônicas (aposta, casa, tipster, origem, seleções e datas); legenda e
    // leitura visual não são fonte prioritária.
    const canonical = row.canonical;
    const stateLabel =
      canonical.state === 'open'
        ? 'Aposta registrada'
        : canonical.state === 'settled'
          ? 'Aposta liquidada'
          : 'Aposta cancelada';
    const stake = canonical.stake;
    const odds = canonical.odds;
    return renderImportMessage({
      status: row.state,
      statusLabel: stateLabel,
      kind: canonical.selections.length > 1 ? 'multiple' : 'simple',
      origin: canonical.origin,
      bookmaker: canonical.bookmaker,
      tipster: canonical.tipster,
      stake,
      odds,
      potentialReturn: stake && odds ? grossReturn(stake, odds) : null,
      placedAt: canonical.placedAt ? formatInstant(canonical.placedAt) : null,
      eventAt: null,
      provisionalAt: null,
      sport: null,
      selections: canonical.selections.map((item) => ({
        event: item.event,
        market: item.market,
        selection: item.selection,
        eventAt: item.eventAt ? formatInstant(item.eventAt) : null,
      })),
    });
  }
  const origin = row.bet_origin === 'real' || row.bet_origin === 'freebet' ? row.bet_origin : null;
  const stake = extraction?.stake ?? null;
  const odds = extraction?.odds ?? null;
  const settled = row.event_date_status === 'confirmed' && row.event_at !== null;
  return renderImportMessage({
    status: row.state,
    statusLabel: STATUS_LABELS[row.state] ?? 'Bilhete atualizado',
    kind: (extraction?.selections.length ?? 1) > 1 ? 'multiple' : 'simple',
    origin,
    bookmaker: row.override_bookmaker ?? labels.bookmaker ?? extraction?.bookmaker ?? null,
    tipster: labels.tipster,
    stake,
    odds,
    potentialReturn: stake && odds ? grossReturn(stake, odds) : null,
    placedAt: extraction?.placedAtText ?? null,
    eventAt: settled ? formatInstant(row.event_at) : null,
    provisionalAt: settled ? null : formatInstant(row.telegram_received_at),
    sport: extraction?.selections.find((item) => item.sport !== null)?.sport ?? null,
    selections: (extraction?.selections ?? []).map((item) => ({
      event: item.event,
      market: item.market,
      selection: item.selection,
    })),
  });
}
