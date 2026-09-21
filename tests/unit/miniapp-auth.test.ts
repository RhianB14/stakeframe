import { describe, expect, it } from 'vitest';
import { telegramInitDataFromHash } from '../../apps/web/src/product/miniapp-auth.js';

describe('Telegram Mini App initData handoff', () => {
  it('reads tgWebAppData from the hash before the Telegram bridge finishes loading', () => {
    expect(
      telegramInitDataFromHash(
        '#miniapp?import=10000000-0000-4000-8000-000000000005&tgWebAppData=auth_date%3D1720000000%26query_id%3DAAF%26hash%3Dabc',
      ),
    ).toBe('auth_date=1720000000&query_id=AAF&hash=abc');
  });

  it('does not treat unrelated hash parameters as initData', () => {
    expect(telegramInitDataFromHash('#miniapp?import=fixture&section=status')).toBe('');
  });
});
