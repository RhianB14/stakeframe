export type PickerOption = {
  value: string;
  label: string;
  description?: string;
  icon?: string;
};

export const SPORT_OPTIONS = [
  'Futebol',
  'Futsal',
  'Futebol Americano',
  'Futebol Australiano',
  'Tênis',
  'Tênis de Mesa',
  'Basquete',
  'Basquete 3x3',
  'Vôlei',
  'Vôlei de Praia',
  'Handebol',
  'Beisebol',
  'Softbol',
  'Hóquei no Gelo',
  'Hóquei sobre Grama',
  'Rugby',
  'Críquete',
  'Badminton',
  'Squash',
  'Padel',
  'MMA',
  'Boxe',
  'Judô',
  'Karatê',
  'Taekwondo',
  'Wrestling',
  'Kickboxing',
  'Fórmula 1',
  'Fórmula E',
  'MotoGP',
  'NASCAR',
  'Automobilismo',
  'Motociclismo',
  'Ciclismo',
  'Golfe',
  'Sinuca',
  'Dardos',
  'Boliche',
  'Atletismo',
  'Natação',
  'Polo Aquático',
  'Surf',
  'Skate',
  'Ginástica',
  'Esqui Alpino',
  'Esqui Cross-Country',
  'Snowboard',
  'Biatlo',
  'Hipismo',
  'Lacrosse',
  'Netball',
  'eSports',
] as const;

const REGION_CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(
    ' ',
  );

const regionNames =
  typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['pt-BR'], { type: 'region' })
    : null;

const flag = (code: string) =>
  code.replace(/[A-Z]/g, (letter) => String.fromCodePoint(127397 + letter.charCodeAt(0)));

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

export const COUNTRY_OPTIONS: PickerOption[] = [
  { value: 'Mundo', label: 'Mundo / Internacional', icon: '🌎' },
  { value: 'Europa', label: 'Europa', icon: '🌍' },
  { value: 'América do Sul', label: 'América do Sul', icon: '🌎' },
  { value: 'América do Norte', label: 'América do Norte', icon: '🌎' },
  { value: 'Ásia', label: 'Ásia', icon: '🌏' },
  { value: 'África', label: 'África', icon: '🌍' },
  { value: 'Oceania', label: 'Oceania', icon: '🌏' },
  ...REGION_CODES.map((code) => ({
    value: regionNames?.of(code) ?? code,
    label: regionNames?.of(code) ?? code,
    icon: flag(code),
  })).sort((left, right) => collator.compare(left.label, right.label)),
];

export const SPORT_PICKER_OPTIONS: PickerOption[] = SPORT_OPTIONS.map((label) => ({
  value: label,
  label,
}));
