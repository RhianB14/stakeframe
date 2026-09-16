import { createFinanceService, createTenantContext, type Database } from '@stakeframe/db';

export async function startMonthlyUnits(database: Database) {
  const finance = createFinanceService(database);
  const tenant = createTenantContext(database);
  const runAll = async () => {
    // Infrastructure iterates organizations: the monthly unit is per tenant.
    for (const context of await tenant.listOrganizations()) {
      await finance.ensureCurrentUnit(context);
    }
  };
  await runAll();
  let running: Promise<void> | null = null;
  let healthy = true;
  const timer = setInterval(() => {
    if (running) return;
    running = runAll()
      .then(() => {
        healthy = true;
      })
      .catch(() => {
        healthy = false;
        console.warn('MONTHLY_UNIT_CHECK_FAILED');
      })
      .finally(() => {
        running = null;
      });
  }, 60_000);
  return {
    check() {
      if (!healthy) throw new Error('MONTHLY_UNIT_UNAVAILABLE');
    },
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
