import {
  freebetReturn,
  grossReturn,
  parseCaption,
  potentialReturnFor,
  renderImportMessage,
  classifyTicketKind,
  ticketKindLabel,
  ticketExtractionSchema,
  normalizeEventLabel,
  type BetOrigin,
  type TicketKind,
} from '@stakeframe/shared';

// Compat: os cálculos vivem no shared (fonte única) e permanecem exportados
// deste módulo para os consumidores históricos.
export { freebetReturn, grossReturn };

// STK-G0-20 — mensagem final do bot a partir do registro canônico.
// Layout fixo com emojis por linha (requisito do produto): "📅 Enviado em" usa
// SEMPRE a data/hora original do Telegram (imutável); "🎮 Evento em" é a data
// do jogo (editável) — "pendente" enquanto não confirmada. O retorno potencial
// é calculado no servidor conforme a modalidade financeira (real, freebet ou
// híbrida); o valor visual da extração é apenas diagnóstico.

const instantFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'short',
  timeStyle: 'short',
});

const formatInstant = (value: string | Date | null) =>
  value === null ? null : instantFormat.format(new Date(value));

// STK-G0-19-R8 — dados canônicos da aposta importada (finance.bet/selection):
// depois da importação a mensagem NÃO usa legenda/OCR como fonte prioritária.
export type CanonicalBetData = {
  state: string;
  bookmaker: string | null;
  tipster: string | null;
  origin: BetOrigin;
  stake: string;
  odds: string;
  /** Valor do crédito freebet (apenas na modalidade híbrida). */
  freebetAmount?: string | null;
  placedAt: Date | null;
  selections: {
    event: string | null;
    sport: string | null;
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
  /** Cadastros/campos manuais declarados no rascunho. */
  override_tipster?: string | null;
  override_sport?: string | null;
  override_tournament?: string | null;
  override_country?: string | null;
  override_kind?: TicketKind | null;
  override_stake?: string | null;
  override_odds?: string | null;
  override_selections?: unknown;
  /** Presente quando a importação já tem aposta registrada. */
  canonical?: CanonicalBetData | null;
  /** Valor do crédito escolhido no rascunho, quando já declarado. */
  draft_freebet_amount?: string | null;
};

const distinctValues = (values: (string | null | undefined)[]): string | null => {
  const parts = values.filter((value): value is string => !!value && value.trim().length > 0);
  const unique = [...new Set(parts.map((value) => value.trim()))];
  return unique.length ? unique.join(' / ') : null;
};

const selectionText = (
  selections: { market: string | null; selection: string | null }[],
  kind: ReturnType<typeof classifyTicketKind>,
) => {
  if (kind === 'simple') return selections[0]?.selection ?? null;
  const values = selections
    .map(({ selection, market }) => [selection, market].filter(Boolean).join(' ').trim())
    .filter(Boolean);
  return values.length ? values.join(' + ') : null;
};

const readSelectionOverrides = (value: unknown) => {
  if (!Array.isArray(value)) return null;
  const selections = value.filter(
    (item): item is { event: string | null; market: string | null; selection: string | null } =>
      !!item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      ['event', 'market', 'selection'].every(
        (key) =>
          (item as Record<string, unknown>)[key] === null ||
          typeof (item as Record<string, unknown>)[key] === 'string',
      ),
  );
  return selections.length === value.length ? selections : null;
};

const draftStatusLabel = (state: string): string => {
  if (state === 'failed') return 'Não conseguimos processar o bilhete';
  if (state === 'discarded') return 'Importação descartada';
  return 'Pendente';
};

const canonicalStatusLabel = (state: string): string =>
  state === 'open' ? 'Pendente' : state === 'settled' ? 'Liquidada' : 'Cancelada';

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
    // financeiras canônicas (aposta, casa, tipster, origem, seleções e datas);
    // legenda e leitura visual não são fonte prioritária.
    const canonical = row.canonical;
    const statusLabel = canonicalStatusLabel(canonical.state);
    const datePending = canonical.selections.every(
      (item) => item.eventAt === null || item.dateStatus !== 'confirmed',
    );
    const firstDate = canonical.selections.find((item) => item.eventAt !== null)?.eventAt ?? null;
    const kind = classifyTicketKind(canonical.selections);
    return renderImportMessage({
      id: row.id,
      statusLabel,
      success: canonical.state === 'open',
      bonus: canonical.origin,
      sport: distinctValues(canonical.selections.map((item) => item.sport)),
      tournament: null,
      event: distinctValues(canonical.selections.map((item) => normalizeEventLabel(item.event))),
      country: null,
      selection: selectionText(canonical.selections, kind),
      market: kind === 'simple' ? (canonical.selections[0]?.market ?? null) : ticketKindLabel[kind],
      stake: canonical.stake,
      odds: canonical.odds,
      potentialReturn: potentialReturnFor(
        canonical.origin,
        canonical.stake,
        canonical.odds,
        canonical.freebetAmount ?? null,
      ),
      kind,
      sentAt: formatInstant(row.telegram_received_at),
      eventAt: datePending || firstDate === null ? null : formatInstant(firstDate),
      bookmaker: canonical.bookmaker,
      tipster: canonical.tipster,
    });
  }
  const origin: BetOrigin =
    row.bet_origin === 'freebet' ? 'freebet' : row.bet_origin === 'hibrida' ? 'hibrida' : 'real';
  const declaredOrigin = row.bet_origin !== null;
  const stake = row.override_stake ?? extraction?.stake ?? null;
  const odds = row.override_odds ?? extraction?.odds ?? null;
  const settled = row.event_date_status === 'confirmed' && row.event_at !== null;
  const selections =
    readSelectionOverrides(row.override_selections) ?? extraction?.selections ?? [];
  const kind = row.override_kind ?? classifyTicketKind(selections);
  return renderImportMessage({
    id: row.id,
    statusLabel: draftStatusLabel(row.state),
    success: row.state === 'review',
    bonus: declaredOrigin ? origin : null,
    sport:
      row.override_sport ??
      extraction?.selections.find((item) => item.sport !== null)?.sport ??
      null,
    tournament: row.override_tournament ?? null,
    event: distinctValues(selections.map((item) => normalizeEventLabel(item.event))),
    country: row.override_country ?? null,
    selection: selectionText(selections, kind),
    market: kind === 'simple' ? (selections[0]?.market ?? null) : ticketKindLabel[kind],
    stake,
    odds,
    // Sem declaração de origem o cálculo assume dinheiro real (caso base);
    // "🎁 Bônus: pendente" comunica que a modalidade ainda não foi declarada.
    potentialReturn:
      stake && odds
        ? potentialReturnFor(origin, stake, odds, row.draft_freebet_amount ?? null)
        : null,
    kind,
    sentAt: formatInstant(row.telegram_received_at),
    eventAt: settled ? formatInstant(row.event_at) : null,
    bookmaker: row.override_bookmaker ?? labels.bookmaker ?? null,
    tipster: row.override_tipster ?? labels.tipster,
  });
}
