import { createHash } from 'node:crypto';

import {
  automaticPolicyV2Schema,
  validatedLayoutSchema,
  type AutomaticPolicyV2,
  type ValidatedLayout,
} from '@stakeframe/shared';

export function layoutDigest(layout: ValidatedLayout) {
  return createHash('sha256')
    .update(JSON.stringify(validatedLayoutSchema.parse(layout)))
    .digest('hex');
}

export function automaticPolicyDigest(policy: AutomaticPolicyV2) {
  return createHash('sha256')
    .update(JSON.stringify(automaticPolicyV2Schema.parse(policy)))
    .digest('hex');
}
