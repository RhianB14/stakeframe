import { z } from 'zod';
import { positiveMoneySchema } from './finance.js';
import { cents, money, oddsInteger, roundedDivide } from './decimal.js';

// STK-F2-10 — freebets: registro, alerta de expiração, calculadora de valor
// efetivo e preferências de notificação por usuário (plano master 2026 §8.7).
//
// Decisões de domínio fixadas aqui, sem depender de serviço externo:
// - O crédito promocional é SEMPRE separado do dinheiro real (§3.6). O valor
//   efetivo é o que a freebet efetivamente entrega, nunca o valor de face da
//   casa — a calculadora é transparente e devolve cada parcela separadamente.
// - A validade (`expires_on`) é uma data civil já no fuso de exibição
//   (São Paulo, §3.7). A expiração efetiva é o FIM desse dia local: um registro
//   com validade 2026-09-30 continua utilizável durante todo o dia 30.

export const FREEBET_REQUIREMENT_KINDS = [
  'min_odds',
  'min_odds_per_selection',
  'min_selections',
  'single_only',
  'no_exchange',
  'sports_restriction',
  'market_restriction',
  'new_customer_only',
  'other',
] as const;
export const freebetRequirementKindSchema = z.enum(FREEBET_REQUIREMENT_KINDS);
export type FreebetRequirementKind = z.infer<typeof freebetRequirementKindSchema>;

/**
 * Requisito relevante do bônus, guardado como estrutura (não texto livre) para
 * que a calculadora possa verificá-lo. `detail` carrega o valor específico do
 * requisito (odd mínima, faixa de esporte, etc.) e nunca é interpretado como
 * regra executável quando o tipo é `other`.
 */
export const freebetRequirementSchema = z.strictObject({
  kind: freebetRequirementKindSchema,
  detail: z.string().trim().min(1).max(200),
});
export type FreebetRequirement = z.infer<typeof freebetRequirementSchema>;

export const freebetStatusSchema = z.enum(['available', 'used', 'expired', 'revoked']);
export type FreebetStatus = z.infer<typeof freebetStatusSchema>;

export const freebetInputSchema = z.strictObject({
  bookmakerId: z.uuid(),
  amount: positiveMoneySchema,
  expiresOn: z.iso.date(),
  stakeReturned: z.boolean(),
  note: z.string().max(500),
  requirements: z.array(freebetRequirementSchema).max(20).default([]),
});
export type FreebetInput = z.infer<typeof freebetInputSchema>;

/** Alteração parcial: o cliente envia apenas o que muda; `null` limpa o campo. */
export const freebetPatchSchema = z
  .strictObject({
    bookmakerId: z.uuid().optional(),
    amount: positiveMoneySchema.optional(),
    expiresOn: z.iso.date().optional(),
    stakeReturned: z.boolean().optional(),
    note: z.string().max(500).optional(),
    requirements: z.array(freebetRequirementSchema).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Informe ao menos um campo para alterar.',
  });
export type FreebetPatch = z.infer<typeof freebetPatchSchema>;

export const freebetRecordSchema = z.object({
  id: z.uuid(),
  bookmakerId: z.uuid(),
  bookmaker: z.string(),
  amount: moneySchemaOf(),
  expiresOn: z.iso.date(),
  /** Instante de expiração efetiva: fim do dia da validade no fuso do usuário. */
  expiresAt: z.iso.datetime({ offset: true }),
  stakeReturned: z.boolean(),
  usedBy: z.uuid().nullable(),
  status: freebetStatusSchema,
  requirements: z.array(freebetRequirementSchema),
  note: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type FreebetRecord = z.infer<typeof freebetRecordSchema>;

// moneySchemaOf evita a dependência circular com ./finance.js, que já reexporta
// decimal.js; o padrão aceito é idêntico ao do contrato financeiro.
function moneySchemaOf() {
  return z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/);
}

export const freebetListQuerySchema = z.strictObject({
  status: z.enum(['all', 'available', 'used', 'expired', 'revoked']).default('all'),
  bookmakerId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type FreebetListQuery = z.infer<typeof freebetListQuerySchema>;

/** Entrada da calculadora: a freebet e a aposta candidata que se quer avaliar. */
export const freebetEvaluationInputSchema = z.strictObject({
  freebetId: z.uuid(),
  /** Odd total da aposta candidata, em decimal string (ex.: '2.50'). */
  odds: z
    .string()
    .regex(/^(0|[1-9]\d{0,5})(\.\d{1,4})?$/)
    .refine((value) => {
      try {
        oddsInteger(value);
        return true;
      } catch {
        return false;
      }
    }, 'Odd fora do intervalo permitido.'),
  /** Número de seleções da aposta candidata (exigência `min_selections`). */
  selections: z.number().int().min(1).max(40),
  /** `true` quando a aposta é simples (uma única seleção) — exigência `single_only`. */
  single: z.boolean(),
  /** Odd mínima por seleção, quando o usuário a conhece. */
  minOddsPerSelection: z
    .string()
    .regex(/^(0|[1-9]\d{0,5})(\.\d{1,4})?$/)
    .nullable()
    .default(null),
  /** Esportes da aposta, se o requisito declarar uma restrição. */
  sports: z.array(z.string().trim().min(1).max(100)).max(40).default([]),
  /** Stake real comprometido na aposta, se houver parte real (aposta híbrida). */
  realStake: z
    .string()
    .regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/)
    .default('0.00'),
});
export type FreebetEvaluationInput = z.infer<typeof freebetEvaluationInputSchema>;

/** Uma linha da calculadora: rótulo, valor e a regra que produziu o valor. */
export const effectiveValueLineSchema = z.object({
  label: z.string(),
  amount: z.string(),
  /** Regra factual que gerou a linha — a calculadora é transparente por contrato. */
  rule: z.string(),
});
export type EffectiveValueLine = z.infer<typeof effectiveValueLineSchema>;

export const effectiveValueSchema = z
  .object({
    freebetId: z.uuid(),
    status: freebetStatusSchema,
    /** Valor de face do crédito (o valor registrado na casa). */
    faceValue: z.string(),
    /** Valor que a freebet entrega se a aposta for ganha, já líquido das exigências. */
    effectiveValue: z.string(),
    /** Retorno total em caso de vitória, incluindo a eventual devolução da stake. */
    totalReturn: z.string(),
    /** Diferença entre valor efetivo e valor de face (nunca positiva). */
    effectiveLoss: z.string(),
    /** O que impede o uso, quando `eligible` é falso. */
    blockers: z.array(z.string()),
    eligible: z.boolean(),
    requirements: z.array(
      z.object({
        kind: freebetRequirementKindSchema,
        detail: z.string(),
        satisfied: z.boolean(),
        actual: z.string().nullable(),
        required: z.string(),
      }),
    ),
    lines: z.array(effectiveValueLineSchema),
  })
  .meta({ id: 'EffectiveValue' });
export type EffectiveValue = z.infer<typeof effectiveValueSchema>;

// ---------------------------------------------------------------- preferências

export const notificationTopicSchema = z.enum([
  'bet_settled',
  'review_pending',
  'freebet_expiring',
]);
export type NotificationTopic = z.infer<typeof notificationTopicSchema>;

export const NOTIFICATION_TOPICS: readonly NotificationTopic[] = [
  'bet_settled',
  'review_pending',
  'freebet_expiring',
];

/** Padrão de entrega: todos os tópicos ligados (o usuário desliga o que quiser). */
export const DEFAULT_TOPIC_FLAGS: Record<NotificationTopic, boolean> = {
  bet_settled: true,
  review_pending: true,
  freebet_expiring: true,
};

export const notificationPreferencesSchema = z
  .object({
    userId: z.string().min(1),
    /** Fuso IANA do usuário — quiet hours são avaliados NESTE fuso. */
    timezone: z.string().trim().min(1).max(64),
    /** Início do silêncio em minutos desde a meia-noite local (0–1439). */
    quietHoursStart: z.number().int().min(0).max(1439),
    /** Fim do silêncio em minutos desde a meia-noite local (0–1439). */
    quietHoursEnd: z.number().int().min(0).max(1439),
    topics: z.record(notificationTopicSchema, z.boolean()),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: 'NotificationPreferences' });
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/** Tópicos sem valor explícito assumem o padrão (ligado): o cliente pode enviar
 * só o que muda, e a resposta sempre traz os três. */
const notificationTopicMapSchema = z
  .object({
    bet_settled: z.boolean().default(true),
    review_pending: z.boolean().default(true),
    freebet_expiring: z.boolean().default(true),
  })
  .partial()
  .transform((value) => ({ ...DEFAULT_TOPIC_FLAGS, ...value }));

export const notificationPreferencesInputSchema = z
  .object({
    timezone: z.string().trim().min(1).max(64),
    quietHoursStart: z.number().int().min(0).max(1439),
    quietHoursEnd: z.number().int().min(0).max(1439),
    topics: notificationTopicMapSchema,
  })
  .meta({ id: 'NotificationPreferencesRequest' });
export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesInputSchema>;

export const notificationRecordSchema = z.object({
  id: z.uuid(),
  topic: notificationTopicSchema,
  subjectId: z.uuid().nullable(),
  /** Janela do alerta (ex.: '24h', '4h') — parte da chave de deduplicação. */
  window: z.string().max(16),
  state: z.enum(['pending', 'delivered', 'skipped_quiet_hours', 'failed', 'cancelled']),
  /** Instante previsto para a entrega, já convertido ao fuso do usuário. */
  scheduledFor: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
});
export type NotificationRecord = z.infer<typeof notificationRecordSchema>;

// ------------------------------------------------------------------ quiet hours

/**
 * `scheduledFor` cai em quiet hours? Avaliado no fuso do usuário, com janela
 * circular (o silêncio pode atravessar a meia-noite).
 */
export function isQuietHour(
  scheduledFor: Date,
  timezone: string,
  quietHoursStart: number,
  quietHoursEnd: number,
): boolean {
  if (quietHoursStart === quietHoursEnd) return false; // janela vazia = nunca silencioso
  const minutes = minutesOfDayIn(scheduledFor, timezone);
  if (minutes === null) return true; // fuso inválido: fail-closed (silencia)
  if (quietHoursStart < quietHoursEnd) return minutes >= quietHoursStart && minutes < quietHoursEnd;
  // Atravessa a meia-noite (ex.: 22:00 → 06:00).
  return minutes >= quietHoursStart || minutes < quietHoursEnd;
}

/** Minutos desde a meia-noite local no fuso informado; null quando o fuso é inválido. */
export function minutesOfDayIn(instant: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(instant);
    const hour = Number(parts.find((part) => part.type === 'hour')!.value);
    const minute = Number(parts.find((part) => part.type === 'minute')!.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    // `hour12: false` pode devolver 24 para 00:00 em alguns runtimes.
    return ((hour % 24) * 60 + minute) % 1440;
  } catch {
    return null;
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Requisitos lidos de jsonb: entrada corrompida vira lista vazia, nunca erro. */
export function parseFreebetRequirements(value: unknown): FreebetRequirement[] {
  const parsed = z.array(freebetRequirementSchema).safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

/** Tópicos lidos de jsonb: ausente assume o padrão ligado, tipo errado é ignorado. */
export function parseNotificationTopics(
  value: unknown,
  defaults: Record<NotificationTopic, boolean>,
): Record<NotificationTopic, boolean> {
  const parsed = z.record(z.string(), z.boolean()).safeParse(value ?? {});
  const topics = { ...defaults };
  for (const topic of NOTIFICATION_TOPICS) {
    const found = parsed.success ? parsed.data[topic] : undefined;
    topics[topic] = typeof found === 'boolean' ? found : true;
  }
  return topics;
}

/** Limita um inteiro a um intervalo; valor fora do contrato é erro do chamador. */
export function clampCount(value: number, min: number, max: number): number {
  if (!Number.isInteger(value)) throw new Error('INVALID_NOTIFICATION_LIMIT');
  if (value < min || value > max) throw new Error('INVALID_NOTIFICATION_LIMIT');
  return value;
}

/**
 * O fuso configurado é válido? A API recusa preferências com fuso desconhecido
 * (fail-closed: um fuso inválio silenciaria toda notificação para sempre).
 */
export const notificationPreferencesInputRefinedSchema = notificationPreferencesInputSchema.refine(
  (value) => isValidTimezone(value.timezone),
  { message: 'Fuso horário desconhecido.', path: ['timezone'] },
);
export type NotificationPreferencesInputRefined = z.infer<
  typeof notificationPreferencesInputRefinedSchema
>;

// ------------------------------------------------------- calculadora (puro)

/** Odd mínima declarada por um requisito `min_odds`, ou null se não houver. */
function requiredOdds(requirements: FreebetRequirement[]): string | null {
  const found = requirements.find((item) => item.kind === 'min_odds');
  if (!found) return null;
  const value = found.detail.replace(',', '.').trim();
  return /^\d+(\.\d{1,4})?$/.test(value) ? value : null;
}

function requiredMinOddsPerSelection(requirements: FreebetRequirement[]): string | null {
  const found = requirements.find((item) => item.kind === 'min_odds_per_selection');
  if (!found) return null;
  const value = found.detail.replace(',', '.').trim();
  return /^\d+(\.\d{1,4})?$/.test(value) ? value : null;
}

function requiredMinSelections(requirements: FreebetRequirement[]): number | null {
  const found = requirements.find((item) => item.kind === 'min_selections');
  if (!found) return null;
  const value = Number.parseInt(found.detail.trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function restrictionValues(
  requirements: FreebetRequirement[],
  kind: FreebetRequirementKind,
): string[] {
  return requirements
    .filter((item) => item.kind === kind)
    .flatMap((item) =>
      item.detail
        .split(',')
        .map((value) => value.trim().toLocaleLowerCase('pt-BR'))
        .filter(Boolean),
    );
}

/**
 * Valor efetivo da freebet, linha a linha, com a regra que produziu cada uma.
 *
 * Regras (todas derivadas do §8.7 e do modelo financeiro já existente):
 * 1. Valor de face = valor do crédito registrado.
 * 2. Valor efetivo = face × (odd − 1) quando a casa NÃO devolve a stake
 *    (promo sem devolução); = face × odd quando devolve (a stake volta).
 * 3. A parte REAL da aposta nunca é ganho: ela sai do valor efetivo
 *    (stake híbrido é proteção contra perda, não lucro).
 * 4. Requisito não satisfeito BLOQUEIA o uso (blocker), não reduz o valor em
 *    silêncio — a diferença entre "vale X" e "não pode usar" é essencial para
 *    o usuário decidir; por isso o payload traz `blockers` e `eligible`.
 */
export function computeEffectiveValue(input: {
  amount: string;
  stakeReturned: boolean;
  requirements: FreebetRequirement[];
  odds: string;
  selections: number;
  single: boolean;
  minOddsPerSelection: string | null;
  sports: string[];
  realStake: string;
}): {
  faceValue: string;
  effectiveValue: string;
  totalReturn: string;
  effectiveLoss: string;
  blockers: string[];
  eligible: boolean;
  requirements: {
    kind: FreebetRequirementKind;
    detail: string;
    satisfied: boolean;
    actual: string | null;
    required: string;
  }[];
  lines: EffectiveValueLine[];
} {
  const face = cents(input.amount);
  if (face <= 0n) throw new Error('INVALID_MONEY');
  const price = oddsInteger(input.odds);
  if (price <= 10_000n) throw new Error('INVALID_ODDS');

  const checks: {
    kind: FreebetRequirementKind;
    detail: string;
    satisfied: boolean;
    actual: string | null;
    required: string;
  }[] = [];
  const blockers: string[] = [];

  const minOdds = requiredOdds(input.requirements);
  if (minOdds !== null) {
    const satisfied = price >= oddsInteger(minOdds);
    checks.push({
      kind: 'min_odds',
      detail: minOdds,
      satisfied,
      actual: decimalFromInteger(price),
      required: minOdds,
    });
    if (!satisfied)
      blockers.push(`Odd ${decimalFromInteger(price)} abaixo do mínimo exigido de ${minOdds}.`);
  }
  const minPerSelection = requiredMinOddsPerSelection(input.requirements);
  if (minPerSelection !== null) {
    const required = oddsInteger(minPerSelection);
    const satisfied =
      input.minOddsPerSelection === null
        ? true
        : oddsInteger(input.minOddsPerSelection) >= required;
    checks.push({
      kind: 'min_odds_per_selection',
      detail: minPerSelection,
      // Odd por seleção desconhecida não é bloqueio: a casa valida na conta.
      satisfied,
      actual: input.minOddsPerSelection,
      required: minPerSelection,
    });
    if (!satisfied)
      blockers.push(
        `Odd mínima por seleção ${input.minOddsPerSelection} abaixo do mínimo exigido de ${minPerSelection}.`,
      );
  }
  const minSelections = requiredMinSelections(input.requirements);
  if (minSelections !== null) {
    const satisfied = input.selections >= minSelections;
    checks.push({
      kind: 'min_selections',
      detail: String(minSelections),
      satisfied,
      actual: String(input.selections),
      required: String(minSelections),
    });
    if (!satisfied)
      blockers.push(
        `Aposta com ${input.selections} seleções abaixo do mínimo exigido de ${minSelections}.`,
      );
  }
  if (input.requirements.some((item) => item.kind === 'single_only')) {
    const satisfied = input.single;
    checks.push({
      kind: 'single_only',
      detail: 'aposta simples',
      satisfied,
      actual: input.single ? 'simples' : 'múltipla',
      required: 'simples',
    });
    if (!satisfied) blockers.push('A freebet exige aposta simples.');
  }
  const sports = restrictionValues(input.requirements, 'sports_restriction');
  if (sports.length > 0) {
    const normalized = input.sports.map((value) => value.trim().toLocaleLowerCase('pt-BR'));
    const satisfied = normalized.some((value) => sports.includes(value));
    checks.push({
      kind: 'sports_restriction',
      detail: sports.join(', '),
      satisfied,
      actual: normalized.join(', ') || null,
      required: sports.join(', '),
    });
    if (!satisfied) blockers.push(`Esporte fora da lista permitida (${sports.join(', ')}).`);
  }
  const markets = restrictionValues(input.requirements, 'market_restriction');
  if (markets.length > 0) {
    checks.push({
      kind: 'market_restriction',
      detail: markets.join(', '),
      satisfied: true,
      actual: null,
      required: markets.join(', '),
    });
  }
  for (const kind of ['no_exchange', 'new_customer_only'] as const) {
    if (!input.requirements.some((item) => item.kind === kind)) continue;
    checks.push({
      kind,
      detail: input.requirements.find((item) => item.kind === kind)!.detail,
      // Restrição de conta: não avaliável offline, nunca bloqueia aqui.
      satisfied: true,
      actual: null,
      required: 'verificar na casa',
    });
  }
  for (const item of input.requirements.filter((entry) => entry.kind === 'other')) {
    checks.push({
      kind: 'other',
      detail: item.detail,
      satisfied: true,
      actual: null,
      required: 'verificar na casa',
    });
  }

  // Valor efetivo: (odd − 1) sem devolução da stake, odd cheio com devolução.
  // A multiplicação é feita em CENTAVOS e só então arredondada (half-up) — dividir
  // antes truncar perderia fração de centavo e subestimaria o valor exibido.
  const factor = input.stakeReturned ? price : price - 10_000n;
  const real = cents(input.realStake);
  const rounded = roundedDivide(face * factor, 10_000n);
  const effective = rounded - real;
  const totalReturn = rounded;

  const lines: EffectiveValueLine[] = [
    {
      label: 'Valor de face do crédito',
      amount: money(face),
      rule: 'Valor registrado na casa (finance.freebet.amount).',
    },
  ];
  if (input.stakeReturned) {
    lines.push({
      label: 'Retorno em caso de vitória (stake devolvida)',
      amount: money(totalReturn),
      rule: 'face × odd — a casa devolve a stake, então o ganho é face × odd.',
    });
  } else {
    lines.push({
      label: 'Retorno em caso de vitória (sem devolução da stake)',
      amount: money(totalReturn),
      rule: 'face × (odd − 1) — sem devolução da stake, o ganho não inclui o valor da aposta.',
    });
  }
  if (real > 0n) {
    lines.push({
      label: 'Parcela real da aposta (não é ganho)',
      amount: money(-real),
      rule: 'A parte real da aposta protege contra a perda, mas não é lucro: sai do valor efetivo.',
    });
  }
  lines.push({
    label: 'Valor efetivo',
    amount: money(effective),
    rule:
      blockers.length > 0
        ? 'Indisponível enquanto houver requisito não satisfeito.'
        : 'Soma das linhas acima.',
  });
  return {
    faceValue: money(face),
    effectiveValue: money(effective),
    totalReturn: money(totalReturn),
    // Perda = quanto do valor de face a freebet NÃO entrega como ganho: na
    // odd 1.50 sem devolução, ela vale 25.00 em vez dos 50.00 de face.
    effectiveLoss: money(effective > face ? 0n : face - effective),
    blockers,
    eligible: blockers.length === 0,
    requirements: checks,
    lines,
  };
}

/** Converte o inteiro de odd (10.000 = 1.00) em decimal string. */
function decimalFromInteger(value: bigint): string {
  const whole = value / 10_000n;
  const fraction = String(value % 10_000n)
    .padStart(4, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
