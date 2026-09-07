import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { StakeframeMonitor } from '../../infra/monitor/worker.mjs';

const env = {
  MONITOR_ENABLED: 'true',
  APP_ORIGIN: 'https://stakeframe.com.br',
  MONITOR_TOKEN: 'a'.repeat(64),
  TELEGRAM_BOT_TOKEN: `123456:${'a'.repeat(40)}`,
  TELEGRAM_OWNER_USER_ID: '123456',
  TELEGRAM_OWNER_CHAT_ID: '123456',
};
const names = [
  'database',
  'worker',
  'backup',
  'restoreTest',
  'retention',
  'disk',
  'importQueue',
  'attachments',
  'aiQuota',
  'aiBudget',
  'eventQueue',
  'recovery',
];
function setup() {
  const db = new DatabaseSync(':memory:');
  const storage = {
    sql: {
      exec(source, ...params) {
        const query = db.prepare(source);
        return { toArray: () => query.all(...params) };
      },
    },
    transactionSync(callback) {
      db.exec('BEGIN');
      try {
        const result = callback();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  // Cloudflare sql.exec executes immediately; adapt node:sqlite without delaying mutations.
  storage.sql.exec = (source, ...params) => {
    const query = db.prepare(source);
    if (/^\s*SELECT/i.test(source)) {
      const rows = query.all(...params);
      return { toArray: () => rows };
    }
    query.run(...params);
    return { toArray: () => [] };
  };
  let now = Date.parse('2026-09-07T12:00:00Z');
  let issue = null;
  let deliveryFailure = false;
  let malformed = false;
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, 'error');
    if (url.startsWith('https://stakeframe.com.br/')) {
      const checks = Object.fromEntries(
        names.map((name) => [name, name === issue ? 'failed' : 'ready']),
      );
      return Response.json(
        malformed
          ? { token: 'private-provider-payload' }
          : {
              checkedAt: new Date(now).toISOString(),
              status: issue ? 'attention' : 'ready',
              checks,
            },
      );
    }
    if (deliveryFailure) throw new Error('Fictional delivery uncertainty');
    const body = JSON.parse(options.body);
    assert.equal(body.chat_id, env.TELEGRAM_OWNER_CHAT_ID);
    assert.ok(!body.text.includes('private-provider-payload'));
    return Response.json({
      ok: true,
      result: { chat: { id: Number(env.TELEGRAM_OWNER_CHAT_ID), type: 'private' } },
    });
  };
  const instance = () => new StakeframeMonitor({ storage }, env, { fetchImpl, now: () => now });
  const check = (monitor) =>
    monitor.fetch(new Request('https://monitor.internal/check', { method: 'POST' }));
  return {
    db,
    instance,
    check,
    requests,
    step() {
      now += 300000;
    },
    issue(value) {
      issue = value;
    },
    failDelivery() {
      deliveryFailure = true;
    },
    malformed() {
      malformed = true;
    },
  };
}

test('stays quiet while healthy, reports a backup incident once, then recovery', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    await fixture.check(monitor);
    fixture.step();
    await fixture.check(monitor);
    assert.equal(fixture.requests.length, 2);
    fixture.issue('backup');
    fixture.step();
    await fixture.check(monitor);
    assert.equal(fixture.requests.filter((entry) => entry.options.method === 'POST').length, 1);
    fixture.step();
    await fixture.check(fixture.instance());
    assert.equal(fixture.requests.filter((entry) => entry.options.method === 'POST').length, 1);
    fixture.issue(null);
    fixture.step();
    await fixture.check(monitor);
    assert.equal(fixture.requests.filter((entry) => entry.options.method === 'POST').length, 2);
  } finally {
    fixture.db.close();
  }
});

test('claims before delivery and does not resend an uncertain message after restart', async () => {
  const fixture = setup();
  try {
    fixture.issue('backup');
    fixture.failDelivery();
    await fixture.check(fixture.instance());
    fixture.step();
    await fixture.check(fixture.instance());
    assert.equal(fixture.requests.filter((entry) => entry.options.method === 'POST').length, 1);
    const status = await fixture.instance().fetch(new Request('https://monitor.internal/status'));
    assert.equal((await status.json()).delivery, 'uncertain');
  } finally {
    fixture.db.close();
  }
});

test('serializes overlapping probes and treats malformed private output as an incident', async () => {
  const fixture = setup();
  try {
    fixture.malformed();
    const monitor = fixture.instance();
    await Promise.all([fixture.check(monitor), fixture.check(monitor)]);
    assert.equal(
      fixture.requests.filter((entry) => entry.url.startsWith('https://stakeframe.com.br/')).length,
      1,
    );
    assert.equal(fixture.requests.filter((entry) => entry.options.method === 'POST').length, 1);
  } finally {
    fixture.db.close();
  }
});

test('exposes no public trigger or status, and disabled schedules perform no calls', async () => {
  assert.equal(
    (await worker.fetch(new Request('https://monitor.example.test/status'), env)).status,
    404,
  );
  assert.equal(
    (await worker.fetch(new Request('https://monitor.example.test/check', { method: 'POST' }), env))
      .status,
    404,
  );
  await worker.scheduled(
    {},
    { MONITOR_ENABLED: 'false' },
    {
      waitUntil: () => {
        throw new Error('Disabled');
      },
    },
  );
});
