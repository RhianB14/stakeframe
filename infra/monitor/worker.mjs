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
const labels = {
  database: 'banco',
  worker: 'processamento',
  backup: 'backup',
  restoreTest: 'ensaio de recuperação',
  retention: 'retenção',
  disk: 'espaço em disco',
  importQueue: 'fila de importação',
  attachments: 'anexos',
  aiQuota: 'cota de IA',
  aiBudget: 'orçamento de IA',
  eventQueue: 'busca de eventos',
  recovery: 'conferência da recuperação',
  application: 'aplicação ou acesso do monitor',
};

function configuration(env) {
  if (env.MONITOR_ENABLED !== 'true') return null;
  if (
    env.APP_ORIGIN !== 'https://stakeframe.com.br' ||
    !/^[a-f0-9]{64}$/.test(env.MONITOR_TOKEN ?? '') ||
    !/^\d{5,16}:[A-Za-z0-9_-]{30,80}$/.test(env.TELEGRAM_BOT_TOKEN ?? '') ||
    !/^[1-9]\d{0,15}$/.test(env.TELEGRAM_OWNER_USER_ID ?? '') ||
    !Number.isSafeInteger(Number(env.TELEGRAM_OWNER_USER_ID)) ||
    env.TELEGRAM_OWNER_CHAT_ID !== env.TELEGRAM_OWNER_USER_ID
  )
    throw new Error('MONITOR_CONFIGURATION_REFUSED');
  for (const name of ['MONITOR_ATTENTION_OBSERVATIONS', 'MONITOR_RECOVERY_OBSERVATIONS']) {
    const value = env[name];
    if (value === undefined) continue;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 24)
      throw new Error('MONITOR_CONFIGURATION_REFUSED');
  }
  const cooldown = env.MONITOR_ALERT_COOLDOWN_MS;
  if (cooldown !== undefined && (!/^\d+$/.test(cooldown) || Number(cooldown) > 86_400_000))
    throw new Error('MONITOR_CONFIGURATION_REFUSED');
  return env;
}

// Hysteresis policy: how many consecutive observations confirm a transition and
// how long different non-worse alerts stay suppressed. Defaults preserve the
// pre-hysteresis alert content while removing per-poll flapping.
function hysteresisPolicy(env) {
  const observations = (name, fallback) => {
    const value = env[name];
    return value !== undefined && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 24
      ? Number(value)
      : fallback;
  };
  const cooldown = env.MONITOR_ALERT_COOLDOWN_MS;
  return {
    attention: observations('MONITOR_ATTENTION_OBSERVATIONS', 3),
    recovery: observations('MONITOR_RECOVERY_OBSERVATIONS', 3),
    cooldownMs:
      cooldown !== undefined && /^\d+$/.test(cooldown) && Number(cooldown) <= 86_400_000
        ? Number(cooldown)
        : 0,
  };
}

function parseSignature(signature) {
  if (!signature || signature === 'ready' || signature === 'application:failed') return new Map();
  return new Map(
    signature.split(',').map((part) => {
      const [name, state] = part.split(':');
      return [name, state];
    }),
  );
}

// A real worsening: a category that was not present before, or a warning that
// escalated to failed. Improvements (subset) never count as worsening.
function isWorse(candidate, notified) {
  if (!notified || notified === 'ready') return candidate !== 'ready';
  if (candidate === 'application:failed') return true;
  if (notified === 'application:failed') return false;
  const next = parseSignature(candidate);
  const current = parseSignature(notified);
  for (const [name, state] of next) {
    const previous = current.get(name);
    if (previous === undefined) return true;
    if (previous === 'warning' && state === 'failed') return true;
  }
  return false;
}

async function json(response, max = 8192) {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  let bytes = 0;
  let source = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > max) throw new Error();
      source += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(source + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function validSignature(signature) {
  if (signature === 'ready' || signature === 'application:failed') return true;
  const parts = signature?.split(',') ?? [];
  if (parts.length === 0 || new Set(parts).size !== parts.length) return false;
  let previous = -1;
  for (const part of parts) {
    const [name, state, extra] = part.split(':');
    const index = names.indexOf(name);
    if (extra !== undefined || index <= previous || !['warning', 'failed'].includes(state))
      return false;
    previous = index;
  }
  return true;
}

function validCompletion(result) {
  if (
    !result ||
    !Number.isSafeInteger(result.startedAt) ||
    !validSignature(result.signature) ||
    !(
      result.httpStatus === null ||
      (Number.isInteger(result.httpStatus) && result.httpStatus >= 100 && result.httpStatus <= 599)
    )
  )
    return false;
  if (result.signature === 'application:failed') {
    if (['health_check', 'health_check_timeout', 'health_check_network'].includes(result.failure))
      return result.httpStatus === null;
    if (result.failure === 'health_check_http')
      return result.httpStatus !== null && (result.httpStatus < 200 || result.httpStatus >= 300);
    if (result.failure === 'health_check_payload')
      return result.httpStatus !== null && result.httpStatus >= 200 && result.httpStatus < 300;
    return false;
  }
  return result.failure === null && result.httpStatus === 200;
}

async function probeHealth(env, fetchImpl, now) {
  let signature;
  let failure = 'health_check';
  let httpStatus = null;
  try {
    const timeout = AbortSignal.timeout(10_000);
    let response;
    try {
      response = await fetchImpl(`${env.APP_ORIGIN}/api/v1/operations/health`, {
        headers: { authorization: `Bearer ${env.MONITOR_TOKEN}` },
        // 'manual' keeps redirects blocked while staying supported by the
        // runtime; 'error' is rejected before any connection (docs/M0-58).
        redirect: 'manual',
        signal: timeout,
      });
    } catch (error) {
      failure =
        timeout.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError'
          ? 'health_check_timeout'
          : 'health_check_network';
      throw error;
    }
    httpStatus = response.status;
    if (!response.ok) {
      failure = 'health_check_http';
      await response.body?.cancel();
      throw new Error();
    }
    let status;
    try {
      status = await json(response);
    } catch {
      failure = 'health_check_payload';
      throw new Error();
    }
    const checkedAt = Date.parse(status.checkedAt);
    if (
      !Number.isFinite(checkedAt) ||
      checkedAt > now + 60_000 ||
      now - checkedAt > 180_000 ||
      !['ready', 'attention'].includes(status.status) ||
      !status.checks ||
      Object.keys(status.checks).sort().join(',') !== [...names].sort().join(',') ||
      Object.values(status.checks).some(
        (value) => !['ready', 'warning', 'failed', 'disabled'].includes(value),
      )
    ) {
      failure = 'health_check_payload';
      throw new Error();
    }
    signature =
      names
        .filter((name) => ['warning', 'failed'].includes(status.checks[name]))
        .map((name) => `${name}:${status.checks[name]}`)
        .join(',') || 'ready';
    if ((signature === 'ready') !== (status.status === 'ready')) {
      failure = 'health_check_payload';
      throw new Error();
    }
    failure = null;
  } catch {
    signature = 'application:failed';
  }
  return { signature, failure, httpStatus };
}

function notificationText(signature) {
  return signature === 'ready'
    ? 'Stakeframe: os sinais operacionais voltaram ao normal.'
    : `Stakeframe precisa de atenção: ${signature
        .split(',')
        .map((part) => labels[part.split(':')[0]])
        .join(', ')}. Confira o procedimento operacional.`;
}

async function deliverNotification(env, fetchImpl, text) {
  try {
    const sent = await fetchImpl(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        // 'manual' keeps redirects blocked; a 3xx is not ok and never followed
        // (docs/M0-58).
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_OWNER_CHAT_ID,
          text,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!sent.ok) {
      await sent.body?.cancel();
      throw new Error();
    }
    const result = await json(sent);
    return (
      result.ok === true &&
      result.result?.chat?.type === 'private' &&
      String(result.result.chat.id) === env.TELEGRAM_OWNER_CHAT_ID
    );
  } catch {
    return false;
  }
}

export class StakeframeMonitor {
  constructor(ctx, env, dependencies = {}) {
    this.storage = ctx.storage;
    this.env = env;
    this.now = dependencies.now ?? Date.now;
    this.policy = hysteresisPolicy(env ?? {});
    this.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS monitor (id INTEGER PRIMARY KEY CHECK(id=1), lease_until INTEGER NOT NULL DEFAULT 0, checked_at INTEGER, signature TEXT, delivery TEXT, fired_at INTEGER, started_at INTEGER, completed_at INTEGER, result TEXT, error TEXT)',
    );
    this.storage.sql.exec('INSERT OR IGNORE INTO monitor(id) VALUES(1)');
    // Databases created before the cron trail existed carry only the legacy
    // columns; add the missing ones in place so the stored state survives the
    // upgrade.
    const columns = new Set(
      this.storage.sql
        .exec('PRAGMA table_info(monitor)')
        .toArray()
        .map((row) => row.name),
    );
    const upgradingHysteresis = !columns.has('stable_signature');
    for (const [name, type] of [
      ['fired_at', 'INTEGER'],
      ['started_at', 'INTEGER'],
      ['completed_at', 'INTEGER'],
      ['result', 'TEXT'],
      ['error', 'TEXT'],
      ['http_status', 'INTEGER'],
      ['stable_signature', 'TEXT'],
      ['candidate_signature', 'TEXT'],
      ['candidate_count', 'INTEGER'],
      ['notified_signature', 'TEXT'],
      ['notified_at', 'INTEGER'],
    ]) {
      if (!columns.has(name))
        this.storage.sql.exec(`ALTER TABLE monitor ADD COLUMN ${name} ${type}`);
    }
    // One-time upgrade backfill: the state observed before the hysteresis
    // upgrade is adopted as stable (and as the last notified signature when the
    // delivery was confirmed) so the first cycle after the upgrade does not
    // re-alert an unchanged condition. Runs only when the columns were just
    // created — never on every boot, which would freeze pending candidates.
    if (upgradingHysteresis) {
      this.storage.sql.exec(
        'UPDATE monitor SET stable_signature=signature WHERE stable_signature IS NULL AND signature IS NOT NULL',
      );
      this.storage.sql.exec(
        "UPDATE monitor SET notified_signature=signature WHERE notified_signature IS NULL AND delivery='confirmed' AND signature IS NOT NULL",
      );
    }
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/status' && request.method === 'GET') {
      const row = this.storage.sql
        .exec(
          'SELECT checked_at,signature,stable_signature,delivery,fired_at,started_at,completed_at,result,error,http_status FROM monitor WHERE id=1',
        )
        .toArray()[0];
      return Response.json({
        lastCheckedAt: row.checked_at,
        state: row.signature === 'ready' ? 'ready' : row.signature ? 'attention' : 'unknown',
        delivery: row.delivery,
        lastFiredAt: row.fired_at,
        lastStartedAt: row.started_at,
        lastCompletedAt: row.completed_at,
        lastResult: row.result,
        lastError: row.error,
        lastHttpStatus: row.http_status,
        lastSignature: row.signature,
        lastStableSignature: row.stable_signature ?? null,
      });
    }
    if (path === '/check/start' && request.method === 'POST') {
      const now = this.now();
      // Record every fire before configuration and lease checks so disabled,
      // refused and overlapping executions remain distinguishable.
      this.storage.sql.exec('UPDATE monitor SET fired_at=? WHERE id=1', now);
      let env;
      try {
        env = configuration(this.env);
      } catch {
        this.storage.sql.exec(
          "UPDATE monitor SET lease_until=0,started_at=?,completed_at=?,result='failed',error='configuration',http_status=NULL WHERE id=1",
          now,
          now,
        );
        return new Response(null, { status: 500 });
      }
      if (!env) return new Response(null, { status: 204 });
      const claimed = this.storage.transactionSync(() => {
        const row = this.storage.sql
          .exec('SELECT lease_until FROM monitor WHERE id=1')
          .toArray()[0];
        if (row.lease_until > now) return false;
        this.storage.sql.exec(
          'UPDATE monitor SET lease_until=?,started_at=? WHERE id=1',
          now + 60_000,
          now,
        );
        return true;
      });
      return claimed ? Response.json({ startedAt: now }) : new Response(null, { status: 204 });
    }
    if (path === '/check/complete' && request.method === 'POST') {
      let result;
      try {
        result = await json(request, 2048);
      } catch {
        return new Response(null, { status: 400 });
      }
      if (!validCompletion(result)) return new Response(null, { status: 400 });
      const completedAt = this.now();
      const policy = this.policy;
      const completion = this.storage.transactionSync(() => {
        const row = this.storage.sql
          .exec(
            'SELECT lease_until,started_at,signature,stable_signature,candidate_signature,candidate_count,notified_signature,notified_at,delivery FROM monitor WHERE id=1',
          )
          .toArray()[0];
        if (row.lease_until === 0 || row.started_at !== result.startedAt) return null;
        const observed = result.signature;
        // Debounce: count consecutive observations of the same signature; only a
        // run of N confirmations promotes it to the stable state.
        let candidate = row.candidate_signature;
        let count = row.candidate_count ?? 0;
        if (observed === candidate) count += 1;
        else {
          candidate = observed;
          count = 1;
        }
        let stable = row.stable_signature;
        let notified = row.notified_signature;
        let notifiedAt = row.notified_at;
        let delivery = row.delivery;
        let notification = null;
        const threshold = candidate === 'ready' ? policy.recovery : policy.attention;
        if (count >= threshold && candidate !== stable) {
          if (candidate === 'ready') {
            // Recovery is announced only after an attention was notified, and at
            // most once per attention cycle.
            if (notified !== null && notified !== 'ready') {
              notification = { signature: 'ready', text: notificationText('ready') };
              notified = 'ready';
              notifiedAt = completedAt;
              delivery = 'uncertain';
            }
            stable = 'ready';
          } else {
            // Identical alerts stay silent; a real worsening bypasses the
            // cooldown; a suppressed different non-worse alert keeps the stable
            // state so the transition is re-evaluated once the window closes.
            const worse = isWorse(candidate, notified);
            const cooldownOpen =
              notifiedAt === null || completedAt - notifiedAt >= policy.cooldownMs || worse;
            if (notified !== candidate && cooldownOpen) {
              notification = { signature: candidate, text: notificationText(candidate) };
              notified = candidate;
              notifiedAt = completedAt;
              delivery = 'uncertain';
              stable = candidate;
            }
          }
        }
        // An unconfirmed delivery is re-offered while its signature is still the
        // stable state, so a failed Telegram send never loses the alert.
        if (!notification && delivery === 'uncertain' && notified !== null && stable === notified)
          notification = { signature: notified, text: notificationText(notified) };
        const failed = observed === 'application:failed';
        this.storage.sql.exec(
          'UPDATE monitor SET lease_until=0,checked_at=?,signature=?,stable_signature=?,candidate_signature=?,candidate_count=?,notified_signature=?,notified_at=?,delivery=?,completed_at=?,result=?,error=?,http_status=? WHERE id=1',
          completedAt,
          observed,
          stable,
          candidate,
          count,
          notified,
          notifiedAt,
          delivery,
          completedAt,
          failed ? 'failed' : observed === 'ready' ? 'ready' : 'attention',
          failed ? result.failure : null,
          result.httpStatus,
        );
        return { notification };
      });
      if (!completion) return new Response(null, { status: 409 });
      return Response.json({
        notification: completion.notification
          ? {
              startedAt: result.startedAt,
              signature: completion.notification.signature,
              text: completion.notification.text,
            }
          : null,
      });
    }
    if (path === '/check/confirm-delivery' && request.method === 'POST') {
      let confirmation;
      try {
        confirmation = await json(request, 1024);
      } catch {
        return new Response(null, { status: 400 });
      }
      if (
        !Number.isSafeInteger(confirmation?.startedAt) ||
        !validSignature(confirmation?.signature)
      )
        return new Response(null, { status: 400 });
      const accepted = this.storage.transactionSync(() => {
        const row = this.storage.sql
          .exec('SELECT started_at,signature,delivery FROM monitor WHERE id=1')
          .toArray()[0];
        if (
          row.started_at !== confirmation.startedAt ||
          row.signature !== confirmation.signature ||
          row.delivery !== 'uncertain'
        )
          return false;
        this.storage.sql.exec("UPDATE monitor SET delivery='confirmed' WHERE id=1");
        return true;
      });
      return new Response(null, { status: accepted ? 204 : 409 });
    }
    return new Response(null, { status: 404 });
  }
}

export function createWorker(dependencies = {}) {
  return {
    async scheduled(_event, env, ctx) {
      const fetchImpl = dependencies.fetchImpl ?? fetch;
      const now = dependencies.now ?? Date.now;
      const stub = env.STAKEFRAME_MONITOR.get(env.STAKEFRAME_MONITOR.idFromName('production'));
      ctx.waitUntil(
        (async () => {
          const started = await stub.fetch(
            new Request('https://monitor.internal/check/start', { method: 'POST' }),
          );
          if (started.status === 204) return;
          if (!started.ok) throw new Error('MONITOR_CHECK_FAILED');
          const claim = await json(started, 1024);
          if (!Number.isSafeInteger(claim?.startedAt)) throw new Error('MONITOR_CHECK_FAILED');

          // External I/O deliberately runs in the stateless scheduled Worker.
          // The Durable Object remains the coordination and persistence atom.
          const result = await probeHealth(env, fetchImpl, now());
          const completed = await stub.fetch(
            new Request('https://monitor.internal/check/complete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ startedAt: claim.startedAt, ...result }),
            }),
          );
          if (!completed.ok) throw new Error('MONITOR_CHECK_FAILED');
          const { notification } = await json(completed, 2048);
          if (!notification) return;

          // The DO claimed delivery as uncertain before returning the message;
          // only an authenticated provider acknowledgement confirms it.
          if (!(await deliverNotification(env, fetchImpl, notification.text))) return;
          const confirmed = await stub.fetch(
            new Request('https://monitor.internal/check/confirm-delivery', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                startedAt: notification.startedAt,
                signature: notification.signature,
              }),
            }),
          );
          if (!confirmed.ok) throw new Error('MONITOR_CHECK_FAILED');
        })(),
      );
    },
    async fetch(request, env) {
      if (
        new URL(request.url).pathname !== '/status' ||
        request.method !== 'GET' ||
        !/^[a-f0-9]{64}$/.test(env.MONITOR_TOKEN ?? '') ||
        request.headers.get('authorization') !== `Bearer ${env.MONITOR_TOKEN}`
      )
        return new Response(null, { status: 404 });
      const stub = env.STAKEFRAME_MONITOR.get(env.STAKEFRAME_MONITOR.idFromName('production'));
      const result = await stub.fetch('https://monitor.internal/status');
      return new Response(result.body, {
        status: result.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    },
  };
}

export default createWorker();
