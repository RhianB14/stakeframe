import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { validatedLayoutsSchema, type ValidatedLayout } from '@stakeframe/shared';
import { IntegrationError } from './http.js';

export function readAutomaticLayouts(env: NodeJS.ProcessEnv): ValidatedLayout[] {
  if (env.AUTOMATIC_IMPORT_ENABLED === undefined || env.AUTOMATIC_IMPORT_ENABLED === 'false')
    return [];
  try {
    const file = env.AUTOMATIC_IMPORT_POLICIES_FILE;
    if (
      env.AUTOMATIC_IMPORT_ENABLED !== 'true' ||
      env.AI_ENABLED !== 'true' ||
      !file ||
      !isAbsolute(file)
    )
      throw new Error();
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 32768) throw new Error();
    const bytes = readFileSync(file);
    if (bytes.length > 32768) throw new Error();
    const layouts = validatedLayoutsSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (!layouts.length || layouts.some((layout) => Date.parse(layout.approvedAt) > Date.now()))
      throw new Error();
    return layouts;
  } catch {
    throw new IntegrationError('AUTOMATIC_IMPORT_CONFIGURATION_INVALID');
  }
}
