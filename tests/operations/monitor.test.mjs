import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { createWorker, StakeframeMonitor } from '../../infra/monitor/worker.mjs';

const env = {
  MONITOR_ENABLED: 'true',
  APP_ORIGIN: 'https://stakeframe.com.br',
  MONITOR_TOKEN: 'a'.repeat(64),
  TELEGRAM_BOT_TOKEN: `123456:${'a'.repeat(40)}`,
  TELEGRAM_OWNER_USER_ID: '123456',
  TELEGRAM_OWNER_CHAT_ID: '123456',
  MONITOR_ATTENTION_OBSERVATIONS: '3',
  MONITOR_RECOVERY_OBSERVATIONS: '3',
  MONITOR_ALERT_COOLDOWN_MS: '0',
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
  let confirmFailure = 0;
  let malformed = false;
  let healthFailure = null;
  const flags = {};
  const cancelable = (key) =>
    new ReadableStream({
      pull() {},
      cancel() {
        flags[key] = true;
      },
    });
  const requests = [];
  const durableRequests = [];
  const monitorEnvironments = new WeakMap();
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, 'manual');
    if (url.startsWith('https://stakeframe.com.br/')) {
      if (healthFailure === 'timeout')
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      if (healthFailure === 'abort')
        throw new DOMException('The operation was aborted', 'AbortError');
      if (healthFailure === 'unclassified') throw new Error('Fictional unclassified failure');
      if (healthFailure === 'network') throw new TypeError('fetch failed');
      if (healthFailure === 'http') return new Response('indisponível', { status: 503 });
      if (healthFailure === 'redirect302')
        return new Response(cancelable('healthRedirectBody'), {
          status: 302,
          headers: { location: 'https://redirect.invalid/login' },
        });
      const checkState = (name) => {
        if (issue == null) return 'ready';
        if (typeof issue === 'string') return name === issue ? 'failed' : 'ready';
        if (Array.isArray(issue)) return issue.includes(name) ? 'failed' : 'ready';
        return issue[name] ?? 'ready';
      };
      const checks = Object.fromEntries(names.map((name) => [name, checkState(name)]));
      const attention = names.some((name) => ['warning', 'failed'].includes(checkState(name)));
      return Response.json(
        malformed
          ? { token: 'private-provider-payload' }
          : {
              checkedAt: new Date(now).toISOString(),
              status: attention ? 'attention' : 'ready',
              checks,
            },
      );
    }
    if (deliveryFailure === 'redirect302')
      return new Response(cancelable('deliveryRedirectBody'), {
        status: 302,
        headers: { location: 'https://redirect.invalid/follow-me' },
      });
    if (deliveryFailure) throw new Error('Fictional delivery uncertainty');
    const body = JSON.parse(options.body);
    assert.equal(body.chat_id, env.TELEGRAM_OWNER_CHAT_ID);
    assert.ok(!body.text.includes('private-provider-payload'));
    return Response.json({
      ok: true,
      result: {
        message_id: 5150,
        chat: { id: Number(env.TELEGRAM_OWNER_CHAT_ID), type: 'private' },
      },
    });
  };
  const instance = (envOverride = env) => {
    const monitor = new StakeframeMonitor({ storage }, envOverride, { now: () => now });
    monitorEnvironments.set(monitor, envOverride);
    return monitor;
  };
  const check = async (monitor) => {
    const waits = [];
    const monitorEnv = monitorEnvironments.get(monitor);
    const scheduledWorker = createWorker({ fetchImpl, now: () => now });
    await scheduledWorker.scheduled(
      {},
      {
        ...monitorEnv,
        STAKEFRAME_MONITOR: {
          idFromName: (name) => `monitor-id:${name}`,
          get: (id) => ({
            async fetch(request) {
              assert.equal(id, 'monitor-id:production');
              durableRequests.push(request);
              if (
                confirmFailure > 0 &&
                new URL(request.url).pathname === '/check/confirm-delivery'
              ) {
                confirmFailure -= 1;
                return new Response(null, { status: 500 });
              }
              return monitor.fetch(new Request(request));
            },
          }),
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
  };
  const read = () => db.prepare('SELECT * FROM monitor WHERE id=1').get();
  return {
    db,
    storage,
    instance,
    check,
    read,
    requests,
    durableRequests,
    flags,
    time: () => now,
    step() {
      now += 300000;
    },
    issue(value) {
      issue = value;
    },
    failDelivery(value = true) {
      deliveryFailure = value;
    },
    failConfirm(count = 1) {
      confirmFailure = count;
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

const telegramPosts = (fixture) =>
  fixture.requests.filter((entry) => entry.options.method === 'POST');
const lastTelegramText = (fixture) => JSON.parse(telegramPosts(fixture).at(-1).options.body).text;
const cycles = async (fixture, monitor, times) => {
  for (let index = 0; index < times; index += 1) {
    await fixture.check(monitor);
    fixture.step();
  }
};

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
      lastStableSignature: null,
    });
    assert.equal(fixture.requests.filter((entry) => entry.options.method === 'POST').length, 0);
    assert.deepEqual(
      fixture.durableRequests.map((request) => new URL(request.url).pathname),
      ['/check/start', '/check/complete'],
    );
    assert.ok(!JSON.stringify(status).includes(env.MONITOR_TOKEN));
  } finally {
    fixture.db.close();
  }
});

test('stays quiet while healthy, reports a stable backup incident once, then recovery', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 0);
    fixture.issue('backup');
    await cycles(fixture, monitor, 2);
    assert.equal(telegramPosts(fixture).length, 0);
    await cycles(fixture, monitor, 1);
    assert.equal(telegramPosts(fixture).length, 1);
    assert.equal(fixture.read().result, 'attention');
    assert.equal(fixture.read().error, null);
    const incident = await statusOf(monitor);
    assert.equal(incident.lastSignature, 'backup:failed');
    assert.equal(incident.lastHttpStatus, 200);
    await cycles(fixture, monitor, 2);
    assert.equal(telegramPosts(fixture).length, 1);
    fixture.issue(null);
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 2);
    assert.equal(
      lastTelegramText(fixture),
      'Stakeframe: os sinais operacionais voltaram ao normal.',
    );
    assert.equal(fixture.read().result, 'ready');
    assert.equal((await statusOf(monitor)).lastSignature, 'ready');
    assert.equal(
      fixture.durableRequests.filter(
        (request) => new URL(request.url).pathname === '/check/confirm-delivery',
      ).length,
      2,
    );
  } finally {
    fixture.db.close();
  }
});

test('retries an uncertain delivery until the provider acknowledges it', async () => {
  const fixture = setup();
  try {
    fixture.issue('backup');
    fixture.failDelivery();
    const monitor = fixture.instance();
    await cycles(fixture, monitor, 3);
    assert.equal(fixture.read().delivery, 'uncertain');
    assert.equal(fixture.read().result, 'attention');
    assert.ok(!fixture.read().receipt_at);
    assert.equal(telegramPosts(fixture).length, 1);
    await cycles(fixture, monitor, 1);
    assert.equal(telegramPosts(fixture).length, 2);
    assert.equal(fixture.read().delivery, 'uncertain');
    assert.equal(
      fixture.durableRequests.filter(
        (request) => new URL(request.url).pathname === '/check/confirm-delivery',
      ).length,
      0,
    );
    fixture.failDelivery(false);
    await cycles(fixture, monitor, 1);
    assert.equal(telegramPosts(fixture).length, 3);
    assert.equal(fixture.read().delivery, 'confirmed');
    assert.ok(fixture.read().receipt_at);
    assert.ok(fixture.read().receipt_id);
    await cycles(fixture, monitor, 1);
    assert.equal(telegramPosts(fixture).length, 3);
    const status = await statusOf(monitor);
    assert.equal(status.delivery, 'confirmed');
    assert.equal(status.lastResult, 'attention');
  } finally {
    fixture.db.close();
  }
});

test('does not resend when the Telegram accepted the message but the internal confirmation failed', async () => {
  const fixture = setup();
  try {
    fixture.issue('backup');
    fixture.failConfirm(1);
    const monitor = fixture.instance();
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 1);
    assert.equal(fixture.read().delivery, 'uncertain');
    assert.ok(fixture.read().receipt_at);
    assert.ok(fixture.read().receipt_id);
    assert.equal(
      fixture.durableRequests.filter(
        (request) => new URL(request.url).pathname === '/check/record-receipt',
      ).length,
      1,
    );
    await cycles(fixture, fixture.instance(), 1);
    assert.equal(telegramPosts(fixture).length, 1);
    assert.equal(fixture.read().delivery, 'confirmed');
    await cycles(fixture, monitor, 1);
    assert.equal(telegramPosts(fixture).length, 1);
  } finally {
    fixture.db.close();
  }
});

test('keeps the recovery under the same receipt reconciliation', async () => {
  const fixture = setup();
  try {
    fixture.issue('retention');
    fixture.failConfirm(1);
    const monitor = fixture.instance();
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 1);
    fixture.issue(null);
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 2);
    assert.equal(
      lastTelegramText(fixture),
      'Stakeframe: os sinais operacionais voltaram ao normal.',
    );
    assert.equal(fixture.read().delivery, 'confirmed');
    await cycles(fixture, monitor, 1);
    assert.equal(telegramPosts(fixture).length, 2);
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
    await cycles(fixture, monitor, 2);
    assert.equal(telegramPosts(fixture).length, 1);
    const status = await statusOf(monitor);
    assert.equal(status.lastResult, 'failed');
    assert.equal(status.lastError, 'health_check_payload');
    assert.equal(status.lastHttpStatus, 200);
    assert.equal(status.lastSignature, 'application:failed');
    assert.equal(status.state, 'attention');
    assert.equal(status.lastFiredAt, fixture.time() - 300000);
    assert.equal(status.lastCompletedAt, fixture.time() - 300000);
  } finally {
    fixture.db.close();
  }
});

test('rejects stale or inconsistent completion and delivery messages', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    const started = await monitor.fetch(
      new Request('https://monitor.internal/check/start', { method: 'POST' }),
    );
    const claim = await started.json();
    const stale = await monitor.fetch(
      new Request('https://monitor.internal/check/complete', {
        method: 'POST',
        body: JSON.stringify({
          startedAt: claim.startedAt - 1,
          signature: 'ready',
          failure: null,
          httpStatus: 200,
        }),
      }),
    );
    assert.equal(stale.status, 409);
    const inconsistent = await monitor.fetch(
      new Request('https://monitor.internal/check/complete', {
        method: 'POST',
        body: JSON.stringify({
          startedAt: claim.startedAt,
          signature: 'application:failed',
          failure: 'health_check_network',
          httpStatus: 503,
        }),
      }),
    );
    assert.equal(inconsistent.status, 400);
    const completed = await monitor.fetch(
      new Request('https://monitor.internal/check/complete', {
        method: 'POST',
        body: JSON.stringify({
          startedAt: claim.startedAt,
          signature: 'backup:failed',
          failure: null,
          httpStatus: 200,
        }),
      }),
    );
    assert.equal(completed.status, 200);
    let latest = claim.startedAt;
    for (let index = 0; index < 2; index += 1) {
      fixture.step();
      const next = await monitor.fetch(
        new Request('https://monitor.internal/check/start', { method: 'POST' }),
      );
      const nextClaim = await next.json();
      latest = nextClaim.startedAt;
      const nextCompleted = await monitor.fetch(
        new Request('https://monitor.internal/check/complete', {
          method: 'POST',
          body: JSON.stringify({
            startedAt: nextClaim.startedAt,
            signature: 'backup:failed',
            failure: null,
            httpStatus: 200,
          }),
        }),
      );
      assert.equal(nextCompleted.status, 200);
    }
    assert.equal(fixture.read().delivery, 'uncertain');
    const wrongConfirmation = await monitor.fetch(
      new Request('https://monitor.internal/check/confirm-delivery', {
        method: 'POST',
        body: JSON.stringify({ startedAt: latest, signature: 'worker:failed' }),
      }),
    );
    assert.equal(wrongConfirmation.status, 409);
    assert.equal(fixture.read().delivery, 'uncertain');
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

test('treats a health redirect as an HTTP failure without following it', async () => {
  const fixture = setup();
  try {
    fixture.failHealth('redirect302');
    const monitor = fixture.instance();
    await fixture.check(monitor);
    const status = await statusOf(monitor);
    assert.equal(status.lastResult, 'failed');
    assert.equal(status.lastError, 'health_check_http');
    assert.equal(status.lastHttpStatus, 302);
    assert.equal(status.lastSignature, 'application:failed');
    assert.equal(status.state, 'attention');
    assert.equal(
      fixture.requests.filter((entry) => entry.url.startsWith('https://stakeframe.com.br/')).length,
      1,
    );
    assert.equal(
      fixture.requests.filter((entry) => entry.url.includes('redirect.invalid')).length,
      0,
    );
    assert.equal(fixture.flags.healthRedirectBody, true);
    let row = fixture.read();
    assert.equal(row.completed_at, fixture.time());
    assert.equal(row.lease_until, 0);
    fixture.step();
    fixture.failHealth(null);
    await fixture.check(monitor);
    row = fixture.read();
    assert.equal(row.result, 'ready');
    assert.equal(row.lease_until, 0);
  } finally {
    fixture.db.close();
  }
});

test('does not follow a Telegram redirect and keeps the delivery uncertain', async () => {
  const fixture = setup();
  try {
    fixture.issue('backup');
    fixture.failDelivery('redirect302');
    const monitor = fixture.instance();
    await cycles(fixture, monitor, 3);
    const row = fixture.read();
    assert.equal(row.delivery, 'uncertain');
    assert.equal(row.result, 'attention');
    assert.equal(row.error, null);
    assert.equal(row.signature, 'backup:failed');
    assert.equal(fixture.flags.deliveryRedirectBody, true);
    assert.equal(
      fixture.requests.filter((entry) => entry.url.includes('redirect.invalid')).length,
      0,
    );
    assert.equal(
      fixture.durableRequests.filter(
        (request) => new URL(request.url).pathname === '/check/confirm-delivery',
      ).length,
      0,
    );
    const status = await statusOf(monitor);
    assert.equal(status.lastSignature, 'backup:failed');
    assert.equal(status.lastResult, 'attention');
    assert.equal(status.delivery, 'uncertain');
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
    await assert.rejects(fixture.check(monitor), /MONITOR_CHECK_FAILED/);
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
    await fixture.check(monitor);
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

test('routes every scheduled fire through the Durable Object claim and surfaces claim failures', async () => {
  const ok = scheduledEnv('true', async () => new Response(null, { status: 204 }));
  const waits = [];
  await worker.scheduled({}, ok.env, { waitUntil: (promise) => waits.push(promise) });
  await Promise.all(waits);
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].id, 'monitor-id:production');
  assert.equal(new URL(ok.calls[0].request.url).pathname, '/check/start');
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
      'stable_signature',
      'candidate_signature',
      'candidate_count',
      'notified_signature',
      'notified_at',
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
    assert.equal(migrated.lastStableSignature, 'ready');
    await fixture.check(monitor);
    assert.equal(fixture.read().result, 'ready');
    assert.equal(fixture.read().fired_at, fixture.time());
  } finally {
    fixture.db.close();
  }
});

test('preserves a legacy uncertain delivery across the upgrade', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE monitor (id INTEGER PRIMARY KEY CHECK(id=1), lease_until INTEGER NOT NULL DEFAULT 0, checked_at INTEGER, signature TEXT, delivery TEXT)',
  );
  db.prepare(
    'INSERT INTO monitor(id,lease_until,checked_at,signature,delivery) VALUES(1,0,?,?,?)',
  ).run(Date.parse('2026-09-07T11:55:00Z'), 'backup:failed', 'uncertain');
  const fixture = setup({ db, now: Date.parse('2026-09-07T12:00:00Z') });
  try {
    const monitor = fixture.instance();
    const migrated = fixture.read();
    assert.equal(migrated.stable_signature, 'backup:failed');
    assert.equal(migrated.notified_signature, 'backup:failed');
    await fixture.check(monitor);
    assert.equal(telegramPosts(fixture).length, 1);
    assert.equal(fixture.read().delivery, 'confirmed');
    await cycles(fixture, monitor, 1);
    assert.equal(telegramPosts(fixture).length, 1);
  } finally {
    fixture.db.close();
  }
});

test('adopts a legacy confirmed state without duplicating the alert', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE monitor (id INTEGER PRIMARY KEY CHECK(id=1), lease_until INTEGER NOT NULL DEFAULT 0, checked_at INTEGER, signature TEXT, delivery TEXT)',
  );
  db.prepare(
    'INSERT INTO monitor(id,lease_until,checked_at,signature,delivery) VALUES(1,0,?,?,?)',
  ).run(Date.parse('2026-09-07T11:55:00Z'), 'backup:failed', 'confirmed');
  const fixture = setup({ db, now: Date.parse('2026-09-07T12:00:00Z') });
  try {
    const monitor = fixture.instance();
    assert.equal(fixture.read().notified_signature, 'backup:failed');
    await cycles(fixture, monitor, 2);
    assert.equal(telegramPosts(fixture).length, 0);
    assert.equal(fixture.read().delivery, 'confirmed');
  } finally {
    fixture.db.close();
  }
});

test('keeps quiet across many healthy cycles', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    await cycles(fixture, monitor, 6);
    assert.equal(telegramPosts(fixture).length, 0);
    assert.equal(fixture.read().result, 'ready');
    assert.equal((await statusOf(monitor)).lastStableSignature, 'ready');
  } finally {
    fixture.db.close();
  }
});

test('does not alert on a transient attention blip', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    await cycles(fixture, monitor, 2);
    fixture.issue('retention');
    await cycles(fixture, monitor, 1);
    fixture.issue(null);
    await cycles(fixture, monitor, 2);
    assert.equal(telegramPosts(fixture).length, 0);
    assert.equal(fixture.read().result, 'ready');
  } finally {
    fixture.db.close();
  }
});

test('alerts once for a persistent attention and stays silent afterwards', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    fixture.issue('retention');
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 1);
    assert.equal(
      lastTelegramText(fixture),
      'Stakeframe precisa de atenção: retenção. Confira o procedimento operacional.',
    );
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 1);
    assert.equal((await statusOf(monitor)).lastStableSignature, 'retention:failed');
  } finally {
    fixture.db.close();
  }
});

test('suppresses a different non-worse alert inside the cooldown and emits it after', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance({ ...env, MONITOR_ALERT_COOLDOWN_MS: '1800000' });
    fixture.issue(['retention', 'disk']);
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 1);
    fixture.issue(['retention']);
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 1);
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 2);
    assert.equal(
      lastTelegramText(fixture),
      'Stakeframe precisa de atenção: retenção. Confira o procedimento operacional.',
    );
  } finally {
    fixture.db.close();
  }
});

test('alerts on a new category during a stable attention', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    fixture.issue({ retention: 'warning' });
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 1);
    fixture.issue({ retention: 'warning', aiBudget: 'warning' });
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 2);
    assert.equal(
      lastTelegramText(fixture),
      'Stakeframe precisa de atenção: retenção, orçamento de IA. Confira o procedimento operacional.',
    );
  } finally {
    fixture.db.close();
  }
});

test('alerts on an escalated severity during a stable attention', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    fixture.issue({ retention: 'warning' });
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 1);
    fixture.issue({ retention: 'failed' });
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 2);
    assert.equal((await statusOf(monitor)).lastStableSignature, 'retention:failed');
  } finally {
    fixture.db.close();
  }
});

test('does not send a recovery when no attention was notified', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    await cycles(fixture, monitor, 3);
    fixture.issue('retention');
    await cycles(fixture, monitor, 1);
    fixture.issue(null);
    await cycles(fixture, monitor, 5);
    assert.equal(telegramPosts(fixture).length, 0);
    assert.equal((await statusOf(monitor)).lastStableSignature, 'ready');
  } finally {
    fixture.db.close();
  }
});

test('sends exactly one recovery per notified attention and can alert again afterwards', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    fixture.issue('worker');
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 1);
    fixture.issue(null);
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 2);
    assert.equal(
      lastTelegramText(fixture),
      'Stakeframe: os sinais operacionais voltaram ao normal.',
    );
    await cycles(fixture, monitor, 2);
    assert.equal(telegramPosts(fixture).length, 2);
    fixture.issue('aiBudget');
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 3);
    assert.equal(
      lastTelegramText(fixture),
      'Stakeframe precisa de atenção: orçamento de IA. Confira o procedimento operacional.',
    );
  } finally {
    fixture.db.close();
  }
});

test('preserves hysteresis state across a worker restart', async () => {
  const fixture = setup();
  try {
    const first = fixture.instance();
    fixture.issue('worker');
    await cycles(fixture, first, 1);
    const restarted = fixture.instance();
    await cycles(fixture, restarted, 2);
    assert.equal(telegramPosts(fixture).length, 1);
    await cycles(fixture, fixture.instance(), 2);
    assert.equal(telegramPosts(fixture).length, 1);
  } finally {
    fixture.db.close();
  }
});

test('serializes concurrent evaluations without duplicate delivery', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    fixture.issue('aiQuota');
    for (let index = 0; index < 4; index += 1) {
      await Promise.all([fixture.check(monitor), fixture.check(monitor)]);
      fixture.step();
    }
    assert.equal(telegramPosts(fixture).length, 1);
    assert.equal(fixture.read().delivery, 'confirmed');
  } finally {
    fixture.db.close();
  }
});

test('serializes concurrent reconciliations without duplicate delivery', async () => {
  const fixture = setup();
  try {
    fixture.issue('aiQuota');
    fixture.failConfirm(1);
    const monitor = fixture.instance();
    await cycles(fixture, monitor, 3);
    assert.equal(telegramPosts(fixture).length, 1);
    assert.equal(fixture.read().delivery, 'uncertain');
    await Promise.all([fixture.check(monitor), fixture.check(monitor)]);
    assert.equal(telegramPosts(fixture).length, 1);
    assert.equal(fixture.read().delivery, 'confirmed');
  } finally {
    fixture.db.close();
  }
});

test('notifies retention, processing and AI budget with their own labels', async () => {
  const cases = [
    ['retention', 'retenção'],
    ['worker', 'processamento'],
    ['aiBudget', 'orçamento de IA'],
  ];
  for (const [name, label] of cases) {
    const fixture = setup();
    try {
      const monitor = fixture.instance();
      fixture.issue(name);
      await cycles(fixture, monitor, 3);
      assert.equal(telegramPosts(fixture).length, 1, `no alert for ${name}`);
      assert.equal(
        lastTelegramText(fixture),
        `Stakeframe precisa de atenção: ${label}. Confira o procedimento operacional.`,
      );
    } finally {
      fixture.db.close();
    }
  }
});

test('rejects an invalid hysteresis configuration', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance({ ...env, MONITOR_ATTENTION_OBSERVATIONS: 'zero' });
    await assert.rejects(fixture.check(monitor), /MONITOR_CHECK_FAILED/);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.read().error, 'configuration');
  } finally {
    fixture.db.close();
  }
});

test('keeps notification payloads and status free of secrets', async () => {
  const fixture = setup();
  try {
    const monitor = fixture.instance();
    fixture.issue('retention');
    await cycles(fixture, monitor, 3);
    const body = JSON.stringify(telegramPosts(fixture).at(-1).options.body);
    assert.ok(!body.includes(env.MONITOR_TOKEN));
    assert.ok(!body.includes(env.TELEGRAM_BOT_TOKEN));
    const status = JSON.stringify(await statusOf(monitor));
    assert.ok(!status.includes(env.MONITOR_TOKEN));
    assert.ok(!status.includes(env.TELEGRAM_BOT_TOKEN));
  } finally {
    fixture.db.close();
  }
});
