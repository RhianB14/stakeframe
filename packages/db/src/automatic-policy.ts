import { createHash } from 'node:crypto';

import { validatedLayoutSchema, type ValidatedLayout } from '@stakeframe/shared';

export function layoutDigest(layout: ValidatedLayout) {
  return createHash('sha256')
    .update(JSON.stringify(validatedLayoutSchema.parse(layout)))
    .digest('hex');
}
