export const BET_MARKET_TYPES = [
  'Goal Line',
  'Set Winner',
  'Total Goals',
  'Set Total Games',
  'Asian Handicap',
  'Handicap Result',
  'Alt Handicap',
  'Bet Builder',
  'Full Time Result',
  'Draw No Bet',
  'Double Chance',
  'First Scorer',
  'Anytime Scorer',
  '2+ Goals',
  '3+ Goals',
  'Player Card',
  'Player Sent Off',
  'Player Shots',
  'Player Fouls',
  'Player Tackles',
  'Player Passes',
  'Player Assists',
  'Goalkeeper Saves',
  'Score Both Halves',
  'Match Red Card',
  'Player Score Or Assist',
  'Match Shots',
  'Match Tackles',
  'Match Offsides',
  'Team Shots',
  'Team Tackles',
  'Team Offsides',
  'Corner Totals',
  'Corners Handicap',
  'Card Totals',
  'Cards Handicap',
  'Money Line',
  'Point Spread',
  'Game Totals',
  'First Basket',
  'Player Points',
  'Player Milestones',
  'Player Rebounds',
  'Player Steals',
  'Player Turnovers',
  'Player Blocks',
  'Player Threes Made',
  'Player Double Double',
  'Player Pts, Assists & Reb',
  '1st Half ML',
  '1st Half Totals',
  '1st Half Spread',
  'Match Winner',
  'Match Handicap',
  'First Blood',
  'Kill Handicap',
  'Total Kills',
  'Kills Race',
  'Multi-Kill',
  'First Goalscorer',
  'Set Betting',
  'Games Handicap',
  'Total Games',
  'Over & BTTS',
  'Team Totals',
  'First 10 Minutes',
  'First Minute',
  'BTTS',
  'To Qualify',
  'Correct Score',
  'Other',
  'Empate',
  'Dupla & Tripla',
  'Fouls',
  'Offsides',
  'Multipla 4+',
  'Tripla Empate',
] as const;

export function canonicalBetMarketType(value: string): string {
  const market = value.trim();
  return (
    BET_MARKET_TYPES.find(
      (type) => type.toLocaleLowerCase('en-US') === market.toLocaleLowerCase('en-US'),
    ) ?? market
  );
}

const STANDARD_BET_MARKET_TYPES = new Set<string>(
  BET_MARKET_TYPES.map((type) => type.toLocaleLowerCase('en-US')),
);
const LEGACY_TICKET_MARKET_LABELS = new Set([
  'simple',
  'straight',
  'multiple',
  'parlay',
  'betbuild',
  'bet builder',
  'multi-sport parlay',
]);

/**
 * Returns useful market labels and filters legacy rows where the ticket format
 * or the selection text was stored in the market field.
 */
export function betMarketTypesForSelections(
  selections: readonly { market: string; selection: string }[],
): string[] {
  const types = selections
    .map(({ market, selection }) => {
      const rawMarket = market.trim();
      const canonical = canonicalBetMarketType(rawMarket);
      const normalized = rawMarket.toLocaleLowerCase('en-US');
      const matchesPick = normalized === selection.trim().toLocaleLowerCase('en-US');
      const isKnownMarket = STANDARD_BET_MARKET_TYPES.has(normalized);
      if (!rawMarket || normalized === 'a definir' || LEGACY_TICKET_MARKET_LABELS.has(normalized))
        return null;
      if (matchesPick && !isKnownMarket) return null;
      return canonical;
    })
    .filter((type): type is string => Boolean(type));

  return [...new Map(types.map((type) => [type.toLocaleLowerCase('en-US'), type])).values()];
}
