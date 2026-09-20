import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  automaticPolicyIsCurrent,
  automaticPolicyV2Schema,
  type AutomaticPolicyV2,
} from '@stakeframe/shared';

// STK-G0-22 — estado explícito da policy global de importação automática.
//
// A declaração do usuário (real/freebet) NUNCA depende deste módulo: aqui só
// vive a elegibilidade da AUTOMAÇÃO. `null` nunca significa autorização; os
// consumidores recebem um estado fechado e tratam qualquer coisa diferente de
// 'approved' como bloqueio (fail-closed → revisão com motivo sanitizado).
export type AutomaticPolicyState = 'absent' | 'invalid' | 'approved';

export function readAutomaticPolicy(): {
  state: AutomaticPolicyState;
  policy: AutomaticPolicyV2 | null;
} {
  const path = process.env.AUTOMATIC_IMPORT_POLICIES_FILE;
  if (!path || !isAbsolute(path)) return { state: 'absent', policy: null };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) {
      return { state: 'invalid', policy: null };
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      return { state: 'invalid', policy: null };
    }
    const parsed = automaticPolicyV2Schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success || !automaticPolicyIsCurrent(parsed.data)) {
      return { state: 'invalid', policy: null };
    }
    return { state: 'approved', policy: parsed.data };
  } catch {
    return { state: 'invalid', policy: null };
  }
}

// Estado efetivo para avisos sanitizados no Mini App/web (disabled quando a
// chave global está desligada — AUTOMATIC_IMPORT_ENABLED=false).
export function automaticPolicyNotice(): 'disabled' | 'absent' | 'invalid' | 'approved' {
  if (process.env.AUTOMATIC_IMPORT_ENABLED !== 'true') return 'disabled';
  return readAutomaticPolicy().state;
}
