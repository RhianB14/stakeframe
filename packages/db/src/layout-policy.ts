import { readFileSync } from 'node:fs';
import { validatedLayoutsSchema, type ValidatedLayout } from '@stakeframe/shared';

// STK-G0-19-R7 — estado EXPLÍCITO da política de importação automática.
//
// A declaração do usuário (real/freebet) NUNCA depende deste módulo: aqui só
// vive a elegibilidade da AUTOMAÇÃO. `null` nunca significa autorização; os
// consumidores recebem um estado fechado e tratam qualquer coisa diferente de
// 'approved' como bloqueio (fail-closed → revisão com motivo sanitizado).
export type AutomaticPolicyState = 'absent' | 'invalid' | 'approved';

export function readAutomaticPolicy(): { state: AutomaticPolicyState; layouts: ValidatedLayout[] } {
  const path = process.env.AUTOMATIC_IMPORT_POLICIES_FILE;
  if (!path) return { state: 'absent', layouts: [] };
  try {
    const parsed = validatedLayoutsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success || !parsed.data.length) return { state: 'invalid', layouts: [] };
    const now = Date.now();
    if (
      parsed.data.some(
        (layout) => Date.parse(layout.approvedAt) > now || Date.parse(layout.expiresAt) <= now,
      )
    )
      return { state: 'invalid', layouts: [] };
    return { state: 'approved', layouts: parsed.data };
  } catch {
    return { state: 'invalid', layouts: [] };
  }
}

// Estado efetivo para avisos sanitizados no Mini App/web (disabled quando a
// chave global está desligada — AUTOMATIC_IMPORT_ENABLED=false).
export function automaticPolicyNotice(): 'disabled' | 'absent' | 'invalid' | 'approved' {
  if (process.env.AUTOMATIC_IMPORT_ENABLED !== 'true') return 'disabled';
  return readAutomaticPolicy().state;
}
