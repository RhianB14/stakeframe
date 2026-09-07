import { z } from 'zod';
import { validatedLayoutSchema, ticketExtractionSchema, type ValidatedLayout } from './imports.js';

export const corpusEvaluationInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  layout: validatedLayoutSchema.omit({
    corpusSha256: true,
    evaluationSha256: true,
    sampleCount: true,
    essentialFieldErrors: true,
    approvedBy: true,
    approvedAt: true,
  }),
  cases: z
    .array(
      z.strictObject({
        imageSha256: z.string().regex(/^[a-f0-9]{64}$/),
        expectedLayoutId: z.string().nullable(),
        expected: ticketExtractionSchema,
        actual: z.strictObject({
          imageSha256: z.string().regex(/^[a-f0-9]{64}$/),
          model: z.string().max(200),
          layoutId: z.string().nullable(),
          extraction: z.unknown(),
          latencyMs: z.number().finite().nonnegative(),
          requestCount: z.number().int().min(1).max(100),
          costUsd: z.number().finite().nonnegative().nullable(),
        }),
      }),
    )
    .min(1)
    .max(10000),
});

export function parseAutomaticPlacedAt(
  text: string | null,
  format: ValidatedLayout['placedAtFormat'],
) {
  if (!text) return null;
  if (format === 'iso-offset') {
    if (!z.iso.datetime({ offset: true }).safeParse(text).success) return null;
    const value = new Date(text);
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  const parts = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!parts) return null;
  const [, day, month, year, hour, minute, second = '00'] = parts;
  const date = `${year}-${month}-${day}`;
  if (!z.iso.date().safeParse(date).success || +hour! > 23 || +minute! > 59 || +second > 59)
    return null;
  const expected = `${date} ${hour}:${minute}:${second}`;
  // Both historical offsets are tested against IANA data. DST gaps and overlaps
  // yield zero or two matches and must be reviewed instead of guessing an instant.
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const matches = ['-03:00', '-02:00']
    .map((offset) => new Date(`${date}T${hour}:${minute}:${second}${offset}`))
    .filter((value) => {
      const fields = formatter.formatToParts(value);
      const part = (key: string) => fields.find((field) => field.type === key)?.value;
      return (
        `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}` ===
        expected
      );
    });
  return matches.length === 1 ? matches[0]!.toISOString() : null;
}

export function automaticEventDate(text: string | null) {
  if (!text) return null;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const value = br ? `${br[3]}-${br[2]}-${br[1]}` : text;
  return z.iso.date().safeParse(value).success ? value : null;
}
