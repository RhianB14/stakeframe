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
      'CREATE TABLE IF NOT EXISTS monitor (id INTEGER PRIMARY KEY CHECK(id=1), lease_until INTEGER NOT NULL DEFAULT 0, checked_at INTEGER, signature TEXT, delivery TEXT)',
    );
    this.storage.sql.exec('INSERT OR IGNORE INTO monitor(id) VALUES(1)');
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/status' && request.method === 'GET') {
      const row = this.storage.sql
        .exec('SELECT checked_at,signature,delivery FROM monitor WHERE id=1')
        .toArray()[0];
      return Response.json({
        lastCheckedAt: row.checked_at,
        state: row.signature === 'ready' ? 'ready' : row.signature ? 'attention' : 'unknown',
        delivery: row.delivery,
      });
    }
    if (path !== '/check' || request.method !== 'POST') return new Response(null, { status: 404 });
    const env = configuration(this.env);
    if (!env) return new Response(null, { status: 204 });
    const now = this.now();
    const claimed = this.storage.transactionSync(() => {
      const row = this.storage.sql.exec('SELECT lease_until FROM monitor WHERE id=1').toArray()[0];
      if (row.lease_until > now) return false;
      this.storage.sql.exec('UPDATE monitor SET lease_until=? WHERE id=1', now + 60_000);
      return true;
    });
    if (!claimed) return new Response(null, { status: 204 });
    let signature = 'application:failed';
    try {
      const response = await this.fetchImpl(`${env.APP_ORIGIN}/api/v1/operations/health`, {
        headers: { authorization: `Bearer ${env.MONITOR_TOKEN}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      const status = await json(response);
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
      )
        throw new Error();
      signature =
        names
          .filter((name) => ['warning', 'failed'].includes(status.checks[name]))
          .map((name) => `${name}:${status.checks[name]}`)
          .join(',') || 'ready';
      if ((signature === 'ready') !== (status.status === 'ready')) throw new Error();
    } catch {
      signature = 'application:failed';
    }
    const previous = this.storage.transactionSync(() => {
      const row = this.storage.sql.exec('SELECT signature FROM monitor WHERE id=1').toArray()[0];
      const changed =
        row.signature !== signature && !(row.signature === null && signature === 'ready');
      // Persist the delivery claim BEFORE sending; a timeout never causes a retry
      // of an external message whose result may already have been accepted.
      this.storage.sql.exec(
        'UPDATE monitor SET checked_at=?,signature=?,delivery=CASE WHEN ? THEN ? ELSE delivery END WHERE id=1',
        now,
        signature,
        changed ? 1 : 0,
        'uncertain',
      );
      return { changed, signature: row.signature };
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
    if (env.MONITOR_ENABLED !== 'true') return;
    const stub = env.STAKEFRAME_MONITOR.get(env.STAKEFRAME_MONITOR.idFromName('production'));
    ctx.waitUntil(stub.fetch(new Request('https://monitor.internal/check', { method: 'POST' })));
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
