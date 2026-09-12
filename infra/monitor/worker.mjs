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
  return env;
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

export class StakeframeMonitor {
  constructor(ctx, env, dependencies = {}) {
    this.storage = ctx.storage;
    this.env = env;
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.now = dependencies.now ?? Date.now;
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
    for (const [name, type] of [
      ['fired_at', 'INTEGER'],
      ['started_at', 'INTEGER'],
      ['completed_at', 'INTEGER'],
      ['result', 'TEXT'],
      ['error', 'TEXT'],
      ['http_status', 'INTEGER'],
    ]) {
      if (!columns.has(name))
        this.storage.sql.exec(`ALTER TABLE monitor ADD COLUMN ${name} ${type}`);
    }
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/status' && request.method === 'GET') {
      const row = this.storage.sql
        .exec(
          'SELECT checked_at,signature,delivery,fired_at,started_at,completed_at,result,error,http_status FROM monitor WHERE id=1',
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
      });
    }
    if (path !== '/check' || request.method !== 'POST') return new Response(null, { status: 404 });
    const now = this.now();
    // Record the fire before evaluating anything else, so a scheduled trigger
    // stays provable even when the configuration is refused or the monitor is
    // disabled.
    this.storage.sql.exec('UPDATE monitor SET fired_at=? WHERE id=1', now);
    let env;
    try {
      env = configuration(this.env);
    } catch {
      this.storage.sql.exec(
        "UPDATE monitor SET started_at=?,completed_at=?,result='failed',error='configuration',http_status=NULL WHERE id=1",
        now,
        now,
      );
      return new Response(null, { status: 500 });
    }
    if (!env) return new Response(null, { status: 204 });
    const claimed = this.storage.transactionSync(() => {
      const row = this.storage.sql.exec('SELECT lease_until FROM monitor WHERE id=1').toArray()[0];
      if (row.lease_until > now) return false;
      this.storage.sql.exec(
        'UPDATE monitor SET lease_until=?,started_at=? WHERE id=1',
        now + 60_000,
        now,
      );
      return true;
    });
    if (!claimed) return new Response(null, { status: 204 });
    let signature = 'application:failed';
    let failure = 'health_check';
    let httpStatus = null;
    try {
      let response;
      try {
        response = await this.fetchImpl(`${env.APP_ORIGIN}/api/v1/operations/health`, {
          headers: { authorization: `Bearer ${env.MONITOR_TOKEN}` },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        failure =
          error?.name === 'TimeoutError' || error?.name === 'AbortError'
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
    const previous = this.storage.transactionSync(() => {
      const row = this.storage.sql.exec('SELECT signature FROM monitor WHERE id=1').toArray()[0];
      const changed =
        row.signature !== signature && !(row.signature === null && signature === 'ready');
      const failed = signature === 'application:failed';
      // Persist the delivery claim BEFORE sending; a timeout never causes a retry
      // of an external message whose result may already have been accepted.
      this.storage.sql.exec(
        'UPDATE monitor SET checked_at=?,signature=?,delivery=CASE WHEN ? THEN ? ELSE delivery END,completed_at=?,result=?,error=?,http_status=? WHERE id=1',
        now,
        signature,
        changed ? 1 : 0,
        'uncertain',
        now,
        failed ? 'failed' : signature === 'ready' ? 'ready' : 'attention',
        failed ? failure : null,
        httpStatus,
      );
      return { changed };
    });
    if (previous.changed) {
      const text =
        signature === 'ready'
          ? 'Stakeframe: os sinais operacionais voltaram ao normal.'
          : `Stakeframe precisa de atenção: ${signature
              .split(',')
              .map((part) => labels[part.split(':')[0]])
              .join(', ')}. Confira o procedimento operacional.`;
      try {
        const sent = await this.fetchImpl(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: 'POST',
            redirect: 'error',
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
        if (
          result.ok !== true ||
          result.result?.chat?.type !== 'private' ||
          String(result.result.chat.id) !== env.TELEGRAM_OWNER_CHAT_ID
        )
          throw new Error();
        this.storage.sql.exec("UPDATE monitor SET delivery='confirmed' WHERE id=1");
      } catch {
        /* Persisted uncertainty remains visible to the operator; no duplicate send. */
      }
    }
    this.storage.sql.exec('UPDATE monitor SET lease_until=0 WHERE id=1');
    return new Response(null, { status: 204 });
  }
}

export default {
  async scheduled(_event, env, ctx) {
    // Every fire reaches the Durable Object — including when the monitor is
    // disabled — so "cron not firing" stays distinguishable from "monitor off",
    // and a refused check surfaces as a failed scheduled invocation for the
    // provider's observability.
    const stub = env.STAKEFRAME_MONITOR.get(env.STAKEFRAME_MONITOR.idFromName('production'));
    ctx.waitUntil(
      (async () => {
        const response = await stub.fetch(
          new Request('https://monitor.internal/check', { method: 'POST' }),
        );
        if (!response.ok) throw new Error('MONITOR_CHECK_FAILED');
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
