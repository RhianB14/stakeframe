import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { validatedLayoutsSchema, type ValidatedLayout } from '@stakeframe/shared';
export function readAutomaticLayouts(env: NodeJS.ProcessEnv): ValidatedLayout[] {
  // STK-G0-19-R7 — fail-closed PARA REVISÃO: política ausente, inválida,
  // ilegível ou expirada nunca derruba o worker nem habilita a automação; o
  // candidato recebe [] e TODA importação segue para revisão com motivo
  // sanitizado (LAYOUT_NOT_VALIDATED), nunca é autoimportada. `null` jamais
  // significa autorização.
  if (env.AUTOMATIC_IMPORT_ENABLED === undefined || env.AUTOMATIC_IMPORT_ENABLED !== 'true')
    return [];
  try {
    const file = env.AUTOMATIC_IMPORT_POLICIES_FILE;
    if (env.AI_ENABLED !== 'true' || !file || !isAbsolute(file)) return [];
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 32768) return [];
    const bytes = readFileSync(file);
    if (bytes.length > 32768) return [];
    const layouts = validatedLayoutsSchema.parse(JSON.parse(bytes.toString('utf8')));
    const now = Date.now();
    if (
      !layouts.length ||
      layouts.some((layout) => Date.parse(layout.approvedAt) > now) ||
      layouts.some((layout) => Date.parse(layout.expiresAt) <= now)
    )
      return [];
    return layouts;
  } catch {
    return [];
  }
}
