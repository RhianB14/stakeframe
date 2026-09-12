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

function makeStorage(db) {
  return {
    sql: {
      exec(source, ...params) {
        const query = db.prepare(source);
        if (/^\s*(SELECT|PRAGMA)/i.test(source)) {
          const rows = query.all(...params);
          return { toArray: () => rows };
        }
        query.run(...params);
        return { toArray: () => [] };
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
}

function setup(options = {}) {
  const db = options.db ?? new DatabaseSync(':memory:');
  const storage = makeStorage(db);
  let now = options.now ?? Date.parse('2026-09-07T12:00:00Z');
  let issue = null;
  let deliveryFailure = false;
  let malformed = false;
  let healthFailure = null;
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, 'error');
    if (url.startsWith('https://stakeframe.com.br/')) {
      if (healthFailure === 'timeout')
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      if (healthFailure === 'abort')
        throw new DOMException('The operation was aborted', 'AbortError');
      if (healthFailure === 'unclassified') throw new Error('Fictional unclassified failure');
      if (healthFailure === 'network') throw new TypeError('fetch failed');
      if (healthFailure === 'http') return new Response('indisponível', { status: 503 });
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
  const instance = (envOverride = env) =>
    new StakeframeMonitor({ storage }, envOverride, { fetchImpl, now: () => now });
  const check = (monitor) =>
    monitor.fetch(new Request('https://monitor.internal/check', { method: 'POST' }));
  const read = () => db.prepare('SELECT * FROM monitor WHERE id=1').get();
  return {
    db,
    storage,
    instance,
    check,
    read,
    requests,
    time: () => now,
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
    failHealth(value) {
      healthFailure = value;
    },
  };
}

const statusOf = async (monitor) =>
  (await monitor.fetch(new Request('https://monitor.internal/status'))).json();

function scheduledEnv(enabled, handler) {
  const calls = [];
  return {
    calls,
    env: {
      MONITOR_ENABLED: enabled,
      STAKEFRAME_MONITOR: {
        idFromName: (name) => `monitor-id:${name}`,
        get: (id) => ({
          async fetch(request) {
            calls.push({ id, request });
            return handler(request);
          },
        }),
      },
    },
  };
}

test('records fire, start and conclusion of a healthy check', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    await fixture.check(monitor);
    const row = fixture.read();
    assert.equal(row.fired_at, fixture.time());
    assert.equal(row.started_at, fixture.time());
    assert.equal(row.completed_at, fixture.time());
    assert.equal(row.checked_at, fixture.time());
    assert.equal(row.result, 'ready');
    assert.equal(row.error, null);
    assert.equal(row.delivery, null);
    const status = await statusOf(monitor);
    assert.deepEqual(status, {
      lastCheckedAt: fixture.time(),
      state: 'ready',
      delivery: null,
      lastFiredAt: fixture.time(),
      lastStartedAt: fixture.time(),
      lastCompletedAt: fixture.time(),
      lastResult: 'ready',
      lastError: null,
      lastHttpStatus: 200,
      lastSignature: 'ready',
    });
    assert.equal(fixture.requests.filter((entry) => entry.options.method === 'POST').length, 0);
    assert.ok(!JSON.stringify(status).includes(env.MONITOR_TOKEN));
  } finally {
    fixture.db.close();
  }
});

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
    assert.equal(fixture.read().result, 'attention');
    assert.equal(fixture.read().error, null);
    const incident = await statusOf(monitor);
    assert.equal(incident.lastSignature, 'backup:failed');
    assert.equal(incident.lastHttpStatus, 200);
    fixture.step();
    await fixture.check(fixture.instance());
    assert.equal(fixture.requests.filter((entry) => entry.options.method === 'POST').length, 1);
    fixture.issue(null);
    fixture.step();
    await fixture.check(monitor);
    assert.equal(fixture.requests.filter((entry) => entry.options.method === 'POST').length, 2);
    assert.equal(fixture.read().result, 'ready');
    assert.equal((await statusOf(monitor)).lastSignature, 'ready');
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
    const row = fixture.read();
    assert.equal(row.delivery, 'uncertain');
    assert.equal(row.result, 'attention');
    assert.equal(row.completed_at, fixture.time());
    fixture.step();
    await fixture.check(fixture.instance());
    assert.equal(fixture.requests.filter((entry) => entry.options.method === 'POST').length, 1);
    const status = await statusOf(fixture.instance());
    assert.equal(status.delivery, 'uncertain');
    assert.equal(status.lastResult, 'attention');
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
    const status = await statusOf(monitor);
    assert.equal(status.lastResult, 'failed');
    assert.equal(status.lastError, 'health_check_payload');
    assert.equal(status.lastHttpStatus, 200);
    assert.equal(status.lastSignature, 'application:failed');
    assert.equal(status.state, 'attention');
    assert.equal(status.lastFiredAt, fixture.time());
    assert.equal(status.lastCompletedAt, fixture.time());
  } finally {
    fixture.db.close();
  }
});

test('classifies a timed out health request and keeps the sanitized signature', async () => {
  const fixture = setup();
  try {
    fixture.failHealth('timeout');
    const monitor = fixture.instance();
    await fixture.check(monitor);
    const status = await statusOf(monitor);
    assert.equal(status.lastResult, 'failed');
    assert.equal(status.lastError, 'health_check_timeout');
    assert.equal(status.lastHttpStatus, null);
    assert.equal(status.lastSignature, 'application:failed');
    assert.equal(status.state, 'attention');
    assert.equal(fixture.read().completed_at, fixture.time());
  } finally {
    fixture.db.close();
  }
});

test('classifies a network failure of the health request', async () => {
  const fixture = setup();
  try {
    fixture.failHealth('network');
    const monitor = fixture.instance();
    await fixture.check(monitor);
    const status = await statusOf(monitor);
    assert.equal(status.lastResult, 'failed');
    assert.equal(status.lastError, 'health_check_network');
    assert.equal(status.lastHttpStatus, null);
  } finally {
    fixture.db.close();
  }
});

test('classifies an unclassified rejection as a network failure while the attempt signal is live', async () => {
  const fixture = setup();
  try {
    fixture.failHealth('unclassified');
    const monitor = fixture.instance();
    await fixture.check(monitor);
    const status = await statusOf(monitor);
    assert.equal(status.lastResult, 'failed');
    assert.equal(status.lastError, 'health_check_network');
    assert.equal(status.lastHttpStatus, null);
    assert.equal(status.lastSignature, 'application:failed');
  } finally {
    fixture.db.close();
  }
});

test('classifies an unclassified rejection as a timeout when the attempt signal itself aborted', async () => {
  const fixture = setup();
  const controller = new AbortController();
  const original = AbortSignal.timeout;
  AbortSignal.timeout = () => controller.signal;
  try {
    fixture.failHealth('unclassified');
    controller.abort();
    const monitor = fixture.instance();
    await fixture.check(monitor);
    const status = await statusOf(monitor);
    assert.equal(status.lastResult, 'failed');
    assert.equal(status.lastError, 'health_check_timeout');
    assert.equal(fixture.read().error, 'health_check_timeout');
    assert.equal(status.lastHttpStatus, null);
    assert.equal(status.lastSignature, 'application:failed');
    assert.equal(status.state, 'attention');
  } finally {
    AbortSignal.timeout = original;
    fixture.db.close();
  }
});

test('classifies AbortError as a timeout', async () => {
  const fixture = setup();
  try {
    fixture.failHealth('abort');
    const monitor = fixture.instance();
    await fixture.check(monitor);
    const status = await statusOf(monitor);
    assert.equal(status.lastResult, 'failed');
    assert.equal(status.lastError, 'health_check_timeout');
    assert.equal(status.lastHttpStatus, null);
  } finally {
    fixture.db.close();
  }
});

test('clears the sanitized error and HTTP status after a timeout failure recovers', async () => {
  const fixture = setup();
  try {
    fixture.failHealth('timeout');
    const monitor = fixture.instance();
    await fixture.check(monitor);
    assert.equal((await statusOf(monitor)).lastError, 'health_check_timeout');
    fixture.step();
    fixture.failHealth(null);
    await fixture.check(monitor);
    const status = await statusOf(monitor);
    assert.equal(status.lastResult, 'ready');
    assert.equal(status.lastError, null);
    assert.equal(status.lastHttpStatus, 200);
    assert.equal(status.lastSignature, 'ready');
  } finally {
    fixture.db.close();
  }
});

test('records the HTTP status when the health endpoint refuses the request', async () => {
  const fixture = setup();
  try {
    fixture.failHealth('http');
    const monitor = fixture.instance();
    await fixture.check(monitor);
    const status = await statusOf(monitor);
    assert.equal(status.lastResult, 'failed');
    assert.equal(status.lastError, 'health_check_http');
    assert.equal(status.lastHttpStatus, 503);
  } finally {
    fixture.db.close();
  }
});

test('records a fire during an active lease without starting a second check', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    await fixture.check(monitor);
    const first = fixture.time();
    fixture.step();
    fixture.db.prepare('UPDATE monitor SET lease_until=? WHERE id=1').run(fixture.time() + 60_000);
    const before = fixture.requests.length;
    await fixture.check(monitor);
    assert.equal(fixture.requests.length, before);
    const row = fixture.read();
    assert.equal(row.fired_at, fixture.time());
    assert.equal(row.started_at, first);
    assert.equal(row.completed_at, first);
    const blocked = await statusOf(monitor);
    assert.ok(blocked.lastFiredAt > blocked.lastCompletedAt);
    fixture.step();
    await fixture.check(monitor);
    assert.equal(fixture.read().completed_at, fixture.time());
    assert.equal(fixture.read().result, 'ready');
  } finally {
    fixture.db.close();
  }
});

test('records a refused configuration as a sanitized failed execution', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance({ ...env, APP_ORIGIN: 'https://stakeframe.example' });
    const response = await fixture.check(monitor);
    assert.equal(response.status, 500);
    assert.equal(fixture.requests.length, 0);
    const row = fixture.read();
    assert.equal(row.fired_at, fixture.time());
    assert.equal(row.started_at, fixture.time());
    assert.equal(row.completed_at, fixture.time());
    assert.equal(row.result, 'failed');
    assert.equal(row.error, 'configuration');
    const status = await statusOf(monitor);
    assert.equal(status.lastResult, 'failed');
    assert.equal(status.lastError, 'configuration');
    assert.equal(status.state, 'unknown');
    assert.equal(status.lastCheckedAt, null);
  } finally {
    fixture.db.close();
  }
});

test('records fires while disabled without starting a check', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance({ ...env, MONITOR_ENABLED: 'false' });
    const response = await fixture.check(monitor);
    assert.equal(response.status, 204);
    assert.equal(fixture.requests.length, 0);
    const row = fixture.read();
    assert.equal(row.fired_at, fixture.time());
    assert.equal(row.started_at, null);
    assert.equal(row.completed_at, null);
    assert.equal(row.result, null);
    const status = await statusOf(monitor);
    assert.equal(status.lastFiredAt, fixture.time());
    assert.equal(status.lastStartedAt, null);
    assert.equal(status.lastResult, null);
  } finally {
    fixture.db.close();
  }
});

test('routes every scheduled fire to the Durable Object and surfaces check failures', async () => {
  const ok = scheduledEnv('true', async () => new Response(null, { status: 204 }));
  const waits = [];
  await worker.scheduled({}, ok.env, { waitUntil: (promise) => waits.push(promise) });
  await Promise.all(waits);
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].id, 'monitor-id:production');
  assert.equal(new URL(ok.calls[0].request.url).pathname, '/check');
  assert.equal(ok.calls[0].request.method, 'POST');

  const broken = scheduledEnv('true', async () => new Response(null, { status: 500 }));
  const brokenWaits = [];
  await worker.scheduled({}, broken.env, { waitUntil: (promise) => brokenWaits.push(promise) });
  assert.equal(brokenWaits.length, 1);
  await assert.rejects(Promise.all(brokenWaits), /MONITOR_CHECK_FAILED/);

  const disabled = scheduledEnv('false', async () => new Response(null, { status: 204 }));
  const disabledWaits = [];
  await worker.scheduled({}, disabled.env, {
    waitUntil: (promise) => disabledWaits.push(promise),
  });
  await Promise.all(disabledWaits);
  assert.equal(disabled.calls.length, 1);
});

test('keeps the private status endpoint behind the exact bearer and exposes no secrets', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    await fixture.check(monitor);
    assert.equal(
      (await worker.fetch(new Request('https://monitor.example.test/status'), env)).status,
      404,
    );
    assert.equal(
      (
        await worker.fetch(
          new Request('https://monitor.example.test/check', { method: 'POST' }),
          env,
        )
      ).status,
      404,
    );
    const wrong = new Request('https://monitor.example.test/status', {
      headers: { authorization: `Bearer ${'b'.repeat(64)}` },
    });
    assert.equal((await worker.fetch(wrong, env)).status, 404);
    const stubEnv = {
      MONITOR_TOKEN: env.MONITOR_TOKEN,
      STAKEFRAME_MONITOR: {
        idFromName: (name) => `monitor-id:${name}`,
        get: (id) => {
          assert.equal(id, 'monitor-id:production');
          return { fetch: (request) => monitor.fetch(new Request(request)) };
        },
      },
    };
    const authorized = new Request('https://monitor.example.test/status', {
      headers: { authorization: `Bearer ${env.MONITOR_TOKEN}` },
    });
    const response = await worker.fetch(authorized, stubEnv);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    assert.ok(!text.includes(env.MONITOR_TOKEN));
    const status = JSON.parse(text);
    assert.equal(status.lastFiredAt, fixture.time());
    assert.equal(status.lastResult, 'ready');
  } finally {
    fixture.db.close();
  }
});

test('migrates a legacy monitor database without losing the stored trail', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE monitor (id INTEGER PRIMARY KEY CHECK(id=1), lease_until INTEGER NOT NULL DEFAULT 0, checked_at INTEGER, signature TEXT, delivery TEXT)',
  );
  db.prepare(
    'INSERT INTO monitor(id,lease_until,checked_at,signature,delivery) VALUES(1,0,?,?,?)',
  ).run(Date.parse('2026-09-07T11:55:00Z'), 'ready', 'confirmed');
  const fixture = setup({ db, now: Date.parse('2026-09-07T12:00:00Z') });
  try {
    const monitor = fixture.instance();
    const columns = db
      .prepare('PRAGMA table_info(monitor)')
      .all()
      .map((row) => row.name);
    for (const name of [
      'fired_at',
      'started_at',
      'completed_at',
      'result',
      'error',
      'http_status',
    ]) {
      assert.ok(columns.includes(name), `missing column ${name}`);
    }
    const migrated = await statusOf(monitor);
    assert.equal(migrated.lastCheckedAt, Date.parse('2026-09-07T11:55:00Z'));
    assert.equal(migrated.state, 'ready');
    assert.equal(migrated.delivery, 'confirmed');
    assert.equal(migrated.lastFiredAt, null);
    assert.equal(migrated.lastResult, null);
    assert.equal(migrated.lastHttpStatus, null);
    assert.equal(migrated.lastSignature, 'ready');
    await fixture.check(monitor);
    assert.equal(fixture.read().result, 'ready');
    assert.equal(fixture.read().fired_at, fixture.time());
  } finally {
    fixture.db.close();
  }
});
