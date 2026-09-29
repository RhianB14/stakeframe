import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createFinanceService,
  createFreebetService,
  createNotificationService,
  createTenantContext,
  expiresAtFor,
  FreebetError,
  requireDatabaseUrl,
  systemOrganizationContext,
  type Database,
  type FreebetService,
  type FinanceService,
  type NotificationService,
  type OrganizationContext,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import type { FreebetRequirement } from '../../packages/shared/src/index.js';

// STK-F2-10 — freebets contra o PostgreSQL real: expiração, deduplicação do
// alerta, quiet hours e isolamento por organização (§15).
//
// O banco é descartável por teste (CREATE DATABASE + migrate + DROP), e os
// fixtures são fictícios. O job de alertas roda aqui de verdade: o que se
// prova é o comportamento do SQL, não uma simulação.

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
let database: Database;
let finance: FinanceService;
let freebets: FreebetService;
let notifications: NotificationService;
let tenantContext: OrganizationContext;
let systemContext: OrganizationContext;
let name: string;

/** Data civil em São Paulo, X dias à frente do instante informado. */
function localDateIn(days: number, from = new Date()): string {
  const instant = new Date(from.getTime() + days * 86_400_000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const pick = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/**
 * Meio-dia em São Paulo, no dia de hoje, como INSTANTE (UTC).
 *
 * Existe para tornar a fila de alertas determinística: o agendamento usa
 * `expiresAt − lead` e o quiet hours padrão (22h–6h) empurra o alerta para as
 * 6h da manhã. Ao meio-dia o alerta da janela de 1 dia JÁ está vencido, então
 * `claimDue` tem o que devolver em qualquer fuso e a qualquer hora em que o
 * teste rodar — sem fixar data (aí a freebet nasceria no passado) e sem tocar
 * na política de silêncio, que é comportamento de produto.
 */
function noonInSaoPaulo(): Date {
  const today = localDateIn(0);
  // −03:00 é o deslocamento de São Paulo; o país não observa horário de
  // verão desde 2019, então a data é sempre reconstruível assim.
  return new Date(`${today}T12:00:00-03:00`);
}

async function bookmakerId(context: OrganizationContext = tenantContext) {
  return (await finance.workspace(context)).catalog.find((row) => row.name === 'Bet365')!.id;
}

async function makeFreebet(
  overrides: {
    expiresOn?: string;
    amount?: string;
    stakeReturned?: boolean;
    requirements?: FreebetRequirement[];
    note?: string;
  } = {},
) {
  return freebets.create(tenantContext, {
    bookmakerId: await bookmakerId(),
    amount: overrides.amount ?? '50.00',
    expiresOn: overrides.expiresOn ?? localDateIn(30),
    stakeReturned: overrides.stakeReturned ?? false,
    note: overrides.note ?? 'Freebet de teste',
    requirements: overrides.requirements ?? [],
  });
}

beforeEach(async () => {
  name = `stk_fb_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_fb_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  const url = new URL(source);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
  finance = createFinanceService(database);
  await database.pool.query(
    "insert into auth.\"user\"(id,name,email) values('fb-owner','Owner Freebet','fb-owner@stk.test') on conflict (id) do nothing",
  );
  tenantContext = await finance.ensureContext('fb-owner');
  systemContext = systemOrganizationContext(tenantContext.organizationId);
  freebets = createFreebetService(database);
  notifications = createNotificationService(database);
});

afterEach(async () => {
  await database?.close();
  if (/^stk_fb_test_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});
afterAll(async () => admin.close());

describe('freebet registration', () => {
  it('registers with bookmaker, amount, expiry, requirements and effective instant', async () => {
    const expiresOn = localDateIn(10);
    const record = await makeFreebet({
      expiresOn,
      amount: '75.00',
      requirements: [
        { kind: 'min_odds', detail: '1.80' },
        { kind: 'min_selections', detail: '2' },
      ],
    });
    expect(record).toMatchObject({
      amount: '75.00',
      expiresOn,
      stakeReturned: false,
      status: 'available',
      usedBy: null,
      bookmaker: 'Bet365',
      requirements: [
        { kind: 'min_odds', detail: '1.80' },
        { kind: 'min_selections', detail: '2' },
      ],
    });
    // A validade é um dia civil: expirar no FIM dele, não à meia-noite.
    expect(record.expiresAt).toBe(expiresAtFor(expiresOn, 'America/Sao_Paulo').toISOString());
    expect(new Date(record.expiresAt).getTime()).toBeGreaterThan(new Date(expiresOn).getTime());
  });

  it('refuses a bookmaker that is not an active entry of the organization', async () => {
    const context = await freebets.ensureContext('fb-owner');
    await database.pool.query(
      "insert into finance.catalog(organization_id,kind,name,active) values($1,'bookmaker','Casa Inativa',false)",
      [context.organizationId],
    );
    const inactive = (
      await database.pool.query<{ id: string }>(
        "select id from finance.catalog where organization_id=$1 and name='Casa Inativa'",
        [context.organizationId],
      )
    ).rows[0]!;
    await expect(
      freebets.create(context, {
        bookmakerId: inactive.id,
        amount: '10.00',
        expiresOn: localDateIn(5),
        stakeReturned: false,
        note: 'x',
        requirements: [],
      }),
    ).rejects.toBeInstanceOf(FreebetError);
  });

  it('updates a freebet that was not used and refuses one that was consumed', async () => {
    const record = await makeFreebet();
    const updated = await freebets.update(tenantContext, record.id, { amount: '60.00' });
    expect(updated.amount).toBe('60.00');
    // Consumo do crédito: é a máquina financeira que marca, e a partir daí a
    // linha é imutável para não apagar a verdade do histórico.
    await database.pool.query(
      'update finance.freebet set used_by=$2 where organization_id=$1 and id=$3',
      [tenantContext.organizationId, randomUUID(), record.id],
    );
    await expect(
      freebets.update(tenantContext, record.id, { amount: '70.00' }),
    ).rejects.toMatchObject({ code: 'FREEBET_ALREADY_USED' });
  });

  it('revokes a freebet but never one already consumed', async () => {
    const record = await makeFreebet();
    const revoked = await freebets.revoke(tenantContext, record.id);
    expect(revoked.status).toBe('revoked');
    await expect(freebets.update(tenantContext, record.id, { note: 'x' })).rejects.toMatchObject({
      code: 'FREEBET_REVOKED',
    });
    const consumed = await makeFreebet();
    await database.pool.query(
      'update finance.freebet set used_by=$2 where organization_id=$1 and id=$3',
      [tenantContext.organizationId, randomUUID(), consumed.id],
    );
    await expect(freebets.revoke(tenantContext, consumed.id)).rejects.toMatchObject({
      code: 'FREEBET_ALREADY_USED',
    });
  });
});

describe('expiry semantics', () => {
  it('keeps the freebet available during its whole validity day', async () => {
    const today = localDateIn(0);
    const record = await makeFreebet({ expiresOn: today });
    expect(record.status).toBe('available');
    expect(
      (await freebets.list(tenantContext, { status: 'available', limit: 50 })).map((row) => row.id),
    ).toContain(record.id);
  });

  it('marks it expired only after the end of the validity day', async () => {
    const yesterday = localDateIn(-1);
    const record = await makeFreebet({ expiresOn: yesterday });
    expect(record.status).toBe('expired');
    expect(record.expiresAt).toBe(expiresAtFor(yesterday, 'America/Sao_Paulo').toISOString());
    // Expirada é imutável — não há o que corrigir em um crédito que já perdeu o prazo.
    await expect(
      freebets.update(tenantContext, record.id, { amount: '10.00' }),
    ).rejects.toMatchObject({ code: 'FREEBET_INVALID' });
  });

  it('computes the effective instant at the end of the day in the user timezone', () => {
    // Mesma data civil, fusos diferentes: o fim do dia muda de instante.
    const saoPaulo = expiresAtFor('2026-12-31', 'America/Sao_Paulo');
    const toquio = expiresAtFor('2026-12-31', 'Asia/Tokyo');
    expect(saoPaulo.toISOString()).toBe('2027-01-01T02:59:59.999Z');
    expect(toquio.toISOString()).toBe('2026-12-31T14:59:59.999Z');
  });
});

describe('effective value calculator against the registry', () => {
  it('reports blockers and the transparent breakdown for a blocked bet', async () => {
    const record = await makeFreebet({
      amount: '50.00',
      requirements: [{ kind: 'min_odds', detail: '2.00' }],
    });
    const result = await freebets.evaluate(tenantContext, {
      freebetId: record.id,
      odds: '1.50',
      selections: 1,
      single: true,
      minOddsPerSelection: null,
      sports: [],
      realStake: '0.00',
    });
    expect(result.status).toBe('available');
    expect(result.eligible).toBe(false);
    expect(result.faceValue).toBe('50.00');
    expect(result.blockers[0]).toMatch(/abaixo do mínimo exigido de 2\.00/);
    expect(result.lines.at(-1)?.rule).toMatch(/Indisponível/);
  });

  it('subtracts the real part of a hybrid bet from the effective value', async () => {
    const record = await makeFreebet({ amount: '50.00' });
    const result = await freebets.evaluate(tenantContext, {
      freebetId: record.id,
      odds: '2.00',
      selections: 1,
      single: true,
      minOddsPerSelection: null,
      sports: [],
      realStake: '10.00',
    });
    expect(result.eligible).toBe(true);
    expect(result.effectiveValue).toBe('40.00');
  });

  it('flags an expired freebet as a blocker even when the math works out', async () => {
    const record = await makeFreebet({ expiresOn: localDateIn(-2) });
    const result = await freebets.evaluate(tenantContext, {
      freebetId: record.id,
      odds: '2.00',
      selections: 1,
      single: true,
      minOddsPerSelection: null,
      sports: [],
      realStake: '0.00',
    });
    expect(result.status).toBe('expired');
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('Freebet expirada.');
  });
});

describe('notification preferences with quiet hours', () => {
  it('returns the documented default when nothing was saved', async () => {
    const preferences = await freebets.preferences(tenantContext, tenantContext.userId);
    expect(preferences).toMatchObject({
      timezone: 'America/Sao_Paulo',
      quietHoursStart: 1320,
      quietHoursEnd: 360,
      topics: { bet_settled: true, review_pending: true, freebet_expiring: true },
    });
  });

  it('persists the timezone, quiet hours and topics of the authenticated user', async () => {
    const saved = await freebets.savePreferences(tenantContext, tenantContext.userId, {
      timezone: 'Asia/Tokyo',
      quietHoursStart: 60,
      quietHoursEnd: 300,
      topics: { bet_settled: true, review_pending: false, freebet_expiring: true },
    });
    expect(saved).toMatchObject({
      timezone: 'Asia/Tokyo',
      quietHoursStart: 60,
      quietHoursEnd: 300,
      topics: { review_pending: false, freebet_expiring: true },
    });
    // Gravar de novo atualiza a MESMA linha (não cria preferência duplicada).
    const again = await freebets.savePreferences(tenantContext, tenantContext.userId, {
      timezone: 'America/Sao_Paulo',
      quietHoursStart: 1320,
      quietHoursEnd: 360,
      topics: { bet_settled: true, review_pending: true, freebet_expiring: true },
    });
    expect(again.timezone).toBe('America/Sao_Paulo');
    const count = (
      await database.pool.query<{ n: string }>(
        'select count(*)::text as n from notification.preference',
      )
    ).rows[0]!;
    expect(Number(count.n)).toBe(1);
  });

  it('refuses an unknown timezone instead of silencing every notification forever', async () => {
    await expect(
      freebets.savePreferences(tenantContext, tenantContext.userId, {
        timezone: 'Mars/Olympus',
        quietHoursStart: 0,
        quietHoursEnd: 0,
        topics: { bet_settled: true, review_pending: true, freebet_expiring: true },
      }),
    ).rejects.toMatchObject({ code: 'FREEBET_INVALID' });
  });
});

describe('expiry alert queue', () => {
  it('enqueues one alert per window and deduplicates repeated runs', async () => {
    await makeFreebet({ expiresOn: localDateIn(2) });
    const first = await notifications.enqueueExpiringFreebets(systemContext, tenantContext.userId);
    expect(first.enqueued).toBeGreaterThan(0);
    // Rodar de novo NÃO duplica: a chave é freebet+janela dentro da organização.
    const second = await notifications.enqueueExpiringFreebets(systemContext, tenantContext.userId);
    expect(second.enqueued).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
    const rows = (
      await database.pool.query<{ n: string }>(
        'select count(*)::text as n from notification.outbox',
      )
    ).rows[0]!;
    expect(Number(rows.n)).toBe(first.enqueued);
  });

  it('ignores freebets outside the alert window, already used and revoked', async () => {
    await makeFreebet({ expiresOn: localDateIn(30) }); // longe demais
    const consumed = await makeFreebet({ expiresOn: localDateIn(2) });
    await database.pool.query(
      'update finance.freebet set used_by=$2 where organization_id=$1 and id=$3',
      [tenantContext.organizationId, randomUUID(), consumed.id],
    );
    const revoked = await makeFreebet({ expiresOn: localDateIn(2) });
    await freebets.revoke(tenantContext, revoked.id);
    const result = await notifications.enqueueExpiringFreebets(systemContext, tenantContext.userId);
    expect(result.enqueued).toBe(0);
  });

  it('defers the alert instead of dropping it when it lands inside quiet hours', async () => {
    // Quiet hours cobrindo o dia INTEIRO: o alerta é adiado, nunca descartado.
    await freebets.savePreferences(tenantContext, tenantContext.userId, {
      timezone: 'America/Sao_Paulo',
      quietHoursStart: 0,
      quietHoursEnd: 1439,
      topics: { bet_settled: true, review_pending: true, freebet_expiring: true },
    });
    await makeFreebet({ expiresOn: localDateIn(1) });
    const result = await notifications.enqueueExpiringFreebets(systemContext, tenantContext.userId);
    expect(result.deferred).toBeGreaterThan(0);
    // Janela cobrando todo o dia: `outsideQuietHours` não acha saída e mantém o
    // instante original — o alerta continua `pending` para o próximo ciclo.
    const rows = (
      await database.pool.query<{ state: string; scheduled: Date }>(
        "select state,scheduled_for as scheduled from notification.outbox where topic='freebet_expiring'",
      )
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.state === 'pending')).toBe(true);
  });

  it('does not enqueue anything when the user disabled the topic', async () => {
    await freebets.savePreferences(tenantContext, tenantContext.userId, {
      timezone: 'America/Sao_Paulo',
      quietHoursStart: 1320,
      quietHoursEnd: 360,
      topics: { bet_settled: true, review_pending: true, freebet_expiring: false },
    });
    await makeFreebet({ expiresOn: localDateIn(1) });
    const result = await notifications.enqueueExpiringFreebets(systemContext, tenantContext.userId);
    expect(result.enqueued).toBe(0);
  });

  it('returns the alert to the queue when the channel is unavailable', async () => {
    // STK-F2-10 (correção de robustez do TESTE, não da lógica): o instante de
    // referência é FIXADO no meio-dia de São Paulo. A fila agenda o alerta em
    // `expiresAt − lead` e o quiet hours padrão (22h–6h) o adia para as 6h;
    // com `now` = horário real da máquina, o teste passava de dia e falhava
    // de noite — `claimDue` devolvia null por DESENHO (nada vencido), não por
    // defeito. Fixar o instante tira a dependência do relógio sem tocar em
    // `enqueueExpiringFreebets`, `claimDue` ou `restore`.
    const at = noonInSaoPaulo();
    await makeFreebet({ expiresOn: localDateIn(1, at) });
    await notifications.enqueueExpiringFreebets(systemContext, tenantContext.userId, at);
    const context = systemOrganizationContext(tenantContext.organizationId);
    const due = await notifications.claimDue(context);
    expect(due).not.toBeNull();
    // A entrega falhou: o alerta NÃO pode ficar marcado como entregue.
    await notifications.restore(due!.id, context);
    const state = (
      await database.pool.query<{ state: string; delivered: Date | null }>(
        'select state,delivered_at as delivered from notification.outbox where id=$1',
        [due!.id],
      )
    ).rows[0]!;
    expect(state.state).toBe('pending');
    expect(state.delivered).toBeNull();
  });

  it('lists the notifications of the authenticated user only', async () => {
    await makeFreebet({ expiresOn: localDateIn(1) });
    await notifications.enqueueExpiringFreebets(systemContext, tenantContext.userId);
    const mine = await notifications.list(tenantContext, tenantContext.userId);
    expect(mine.length).toBeGreaterThan(0);
    const stranger = await notifications.list(tenantContext, 'outro-usuario');
    expect(stranger).toHaveLength(0);
  });
});

describe('organization isolation', () => {
  it('never exposes one organization freebet to another', async () => {
    const record = await makeFreebet();
    // A organização B é criada depois e o registro de A existe antes: um teste
    // que passa antes e depois do isolamento não provaria nada.
    await database.pool.query(
      "insert into auth.\"user\"(id,name,email) values('fb-other','Other Owner','fb-other@stk.test') on conflict (id) do nothing",
    );
    const other = await freebets.ensureContext('fb-other');
    expect(other.organizationId).not.toBe(tenantContext.organizationId);

    await expect(freebets.get(other, record.id)).rejects.toMatchObject({
      code: 'FREEBET_NOT_FOUND',
    });
    const list = await freebets.list(other, { status: 'all', limit: 50 });
    expect(list).toHaveLength(0);
    // A freebet de A continua intacta para quem é dona dela.
    expect((await freebets.get(tenantContext, record.id)).id).toBe(record.id);
  });

  it('keeps the alert queue of one organization out of the other', async () => {
    await makeFreebet({ expiresOn: localDateIn(1) });
    await database.pool.query(
      "insert into auth.\"user\"(id,name,email) values('fb-other','Other Owner','fb-other@stk.test') on conflict (id) do nothing",
    );
    const other = await freebets.ensureContext('fb-other');
    // A enfileira no SEU contexto com o SEU usuário (par válido para a FK).
    await notifications.enqueueExpiringFreebets(systemContext, tenantContext.userId);
    // B faz o mesmo passe no contexto DELE. B não tem freebet própria: nada entra
    // na fila de B, apesar de a fila de A existir e estar vencida.
    const otherSystem = systemOrganizationContext(other.organizationId);
    const mine = await notifications.enqueueExpiringFreebets(otherSystem, other.userId);
    expect(mine.enqueued).toBe(0);
    const visible = await notifications.list(other, other.userId);
    expect(visible).toHaveLength(0);
    // O par (contexto de B, usuário de A) não pode escrever a fila de B: o
    // predicado explícito de organização é a defesa, e a linha criada por A
    // fica invisível para o contexto de B.
    const crossed = await notifications.enqueueExpiringFreebets(otherSystem, tenantContext.userId);
    expect(crossed.enqueued).toBe(0);
    expect(
      await database.pool
        .query<{ n: string }>(
          'select count(*)::text as n from notification.outbox where user_id=$1',
          [tenantContext.userId],
        )
        .then((rows) => Number(rows.rows[0]!.n)),
    ).toBeGreaterThan(0);
  });

  it('iterates organizations from the registry, not from a client value', async () => {
    await database.pool.query(
      "insert into auth.\"user\"(id,name,email) values('fb-other','Other Owner','fb-other@stk.test') on conflict (id) do nothing",
    );
    const other = await freebets.ensureContext('fb-other');
    const tenant = createTenantContext(database);
    const organizations = await tenant.listOrganizations();
    expect(organizations.map((row) => row.organizationId).sort()).toEqual(
      [tenantContext.organizationId, other.organizationId].sort(),
    );
    expect(organizations.every((row) => row.userId === 'system:worker')).toBe(true);
  });
});
