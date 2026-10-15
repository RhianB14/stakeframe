export function ticketSportLabel(value: string | null) {
  const sport = value?.trim() ?? '';
  if (!sport) return 'OTH';
  if (/^other$/i.test(sport)) return 'OTH';
  if (/\bnfl\b|american football|futebol americano/i.test(sport)) return 'NFL';
  if (/\bncaabb\b/i.test(sport)) return 'NCAABB';
  if (/\bncaaf\b|ncaa football|college football/i.test(sport)) return 'NCAAF';
  if (/ncaab|ncaa basketball|college basketball|\bncaa\b/i.test(sport)) return 'NCAAB';
  if (/\bwnba\b/i.test(sport)) return 'WNBA';
  if (/\bnba\b|basquet|basket/i.test(sport)) return 'NBA';
  if (/f[uú]tbol|futebol|football|soccer/i.test(sport)) return 'FUT';
  if (/\bmlb\b|baseball|beisebol/i.test(sport)) return 'MLB';
  if (/\bnhl\b|hockey|hóquei/i.test(sport)) return 'NHL';
  if (/tennis|tênis|tenis/i.test(sport)) return 'TENNIS';
  if (/\b(mma|ufc)\b/i.test(sport)) return 'MMA';
  if (/volleyball|voleibol|vôlei|volei/i.test(sport)) return 'VOLLEY';
  if (/esports|e-sports|valorant|counter-strike|\bcs2\b|league of legends|\bdota\b/i.test(sport))
    return 'ESPORTS';
  if (/formula\s*1|\bf1\b/i.test(sport)) return 'F1';
  if (/golf|golfe/i.test(sport)) return 'GOLF';
  if (/rugby/i.test(sport)) return 'RUGBY';
  return sport.toUpperCase();
}
