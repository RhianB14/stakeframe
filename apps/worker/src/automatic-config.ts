import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  automaticPolicyIsCurrent,
  automaticPolicyV3Schema,
  type AutomaticPolicyV3,
} from '@stakeframe/shared';

export type AutomaticPolicyRead = {
  state: 'absent' | 'invalid' | 'approved';
  policy: AutomaticPolicyV3 | null;
};

export function readAutomaticPolicy(env: NodeJS.ProcessEnv): AutomaticPolicyRead {
  // Fail-closed: a policy ausente, inválida, ilegível ou expirada nunca
  // derruba o worker nem habilita a automação. O serviço recebe estado não
  // aprovado e mantém toda importação em revisão; null jamais é autorização.
  if (env.AUTOMATIC_IMPORT_ENABLED === undefined || env.AUTOMATIC_IMPORT_ENABLED !== 'true')
    return { state: 'absent', policy: null };
  try {
    const file = env.AUTOMATIC_IMPORT_POLICIES_FILE;
    if (env.AI_ENABLED !== 'true' || !file || !isAbsolute(file))
      return { state: 'absent', policy: null };
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768)
      return { state: 'invalid', policy: null };
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      return { state: 'invalid', policy: null };
    const bytes = readFileSync(file);
    if (bytes.length > 32_768) return { state: 'invalid', policy: null };
    const parsed = automaticPolicyV3Schema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!parsed.success || !automaticPolicyIsCurrent(parsed.data))
      return { state: 'invalid', policy: null };
    return { state: 'approved', policy: parsed.data };
  } catch {
    return { state: 'invalid', policy: null };
  }
}
