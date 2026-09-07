import { createFinanceService, type Database } from '@stakeframe/db';

export async function startMonthlyUnits(database: Database) {
  const finance = createFinanceService(database);
  await finance.ensureCurrentUnit();
  let running: Promise<void> | null = null;
  let healthy = true;
  const timer = setInterval(() => {
    if (running) return;
    running = finance
      .ensureCurrentUnit()
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
