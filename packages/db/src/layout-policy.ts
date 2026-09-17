import { readFileSync } from 'node:fs';
import { validatedLayoutsSchema, type ValidatedLayout } from '@stakeframe/shared';

// STK-G0-19-R6 — contexto de política de layouts aprovados (o MESMO arquivo
// privado configurado para o worker). Usado para decidir se um freebet pode ser
// escolhido num rascunho: sem arquivo configurado (dev/testes) não há contexto
// (null); com arquivo presente a decisão é fail-closed — somente um layout
// aprovado, vigente e com allowFreebet libera o crédito.

export function freebetAllowedByPolicy(
  bookmakerId: string,
  now: Date = new Date(),
): boolean | null {
  const path = process.env.AUTOMATIC_IMPORT_POLICIES_FILE;
  if (!path) return null;
  const read = (): ValidatedLayout[] | null => {
    try {
      const parsed = validatedLayoutsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
  const layouts = read();
  if (!layouts) return false;
  return layouts.some(
    (layout) =>
      layout.bookmakerId === bookmakerId &&
      layout.allowFreebet &&
      new Date(layout.expiresAt).getTime() > now.getTime(),
  );
}
