import { describe, expect, it } from 'vitest';
import { csvCell } from '../../packages/db/src/reports.js';
import { reportQuerySchema, formatReportBRL } from '../../packages/shared/src/index.js';
import { reportRange } from '../../packages/db/src/report-query.js';

describe('report boundaries and spreadsheet safety', () => {
  it.each([
    '=1+1',
    '+SUM(A1)',
    '-1+2',
    '@SUM(A1)',
    '  =1',
    '\tformula',
    '\rformula',
    '\nformula',
    '\u0000 =1',
  ])('escapes untrusted spreadsheet text %j', (value) => {
    expect(csvCell(value)).toBe(`"'${value}"`);
  });
  it('preserves legitimate signed numeric values and quotes text with commas and newlines', () => {
    expect(csvCell('-10.00', true)).toBe('"-10.00"');
    expect(csvCell('Aurora, "Central"\nResultado')).toBe('"Aurora, ""Central""\nResultado"');
    expect(csvCell(null)).toBe('""');
  });
  it('supports aggregate values beyond single movement limits without float rounding', () => {
    expect(formatReportBRL('99999999999999999999999999.99')).toBe(
      'R$ 99.999.999.999.999.999.999.999.999,99',
    );
    expect(formatReportBRL('-0.01')).toBe('−R$ 0,01');
  });
  it('uses equal length previous windows and rejects reversed/unbounded periods', () => {
    expect(
      reportRange(reportQuerySchema.parse({ from: '2024-03-01', to: '2024-03-31' })),
    ).toMatchObject({
      days: 31,
      previousFrom: '2024-01-30',
      previousTo: '2024-02-29',
      granularity: 'day',
    });
    expect(() =>
      reportRange(reportQuerySchema.parse({ from: '2026-10-01', to: '2026-09-01' })),
    ).toThrow();
    expect(() =>
      reportRange(reportQuerySchema.parse({ from: '1000-01-01', to: '2026-09-01' })),
    ).toThrow();
  });
});
