import { createHash } from 'node:crypto';

import {
  automaticPolicyV3Schema,
  validatedLayoutSchema,
  type AutomaticPolicyV3,
  type ValidatedLayout,
} from '@stakeframe/shared';

export function layoutDigest(layout: ValidatedLayout) {
  return createHash('sha256')
    .update(JSON.stringify(validatedLayoutSchema.parse(layout)))
    .digest('hex');
}

export function automaticPolicyDigest(policy: AutomaticPolicyV3) {
  return createHash('sha256')
    .update(JSON.stringify(automaticPolicyV3Schema.parse(policy)))
    .digest('hex');
}

/**
 * Catalog name → policy slug ('Bet365' → 'bet365'). The seed catalog uses the
 * canonical house names; an unrecognized name maps to null and the caller must
 * treat it as not approved (fail-closed → manual review).
 */
export function automaticBookmakerSlug(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const slug = name.trim().toLowerCase();
  return slug.length ? slug : null;
}
