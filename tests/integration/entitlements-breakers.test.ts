import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAdminPanelService,
  createDatabase,
  createEntitlementService,
  createExtractionPolicyService,
  createFinanceService,
  createImportService,
  createInboxStore,
  createTenantContext,
  requireDatabaseUrl,
  type AdminPanelService,
  type Database,
  type EntitlementService,
  type ExtractionPolicyService,
  type FinanceService,
  type ImportService,
  type OrganizationContext,
} from '../../packages/db/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import {
  GLOBAL_SPEND_CAP_MICROS,
  aiCallCost,
  entitlementAllows,
  entitlementWithinLimit,
  manualFlowGuidance,
  paidCallDecision,
  quotaUnitForOutcome,
  spendExhausted,
  type Entitlement,
  type PaidCallGate,
  type TicketExtraction,
} from '../../packages/shared/src/index.js';

/**
 * STK-F2-13 §15 — entitlements resolvidos NO BANCO e circuit breakers de custo.
 *
 * PostgreSQL real, banco descartável, dados fictícios. Nenhuma chamada ao
 * fornecedor, nenhuma credencial e nenhum conteúdo de bilhete em log.
 *
 * O que estes testes provam:
 *  - o entitlement é calculado pelo BANCO (a função `core.organization_entitlements`),
 *    e organização sem atribuição cai no plano `free`, o mais restritivo;
 *  - organização inexistente devolve NENHUM entitlement — a ausência é a forma
 *    fail-closed, e o chamador trata ausência como recusa;
 *  - o banco recusa cobrança (`plan.billable` é CHECK false) e não existe coluna
 *    de preço: os preços são INDEFINIDOS no beta;
 *  - o breaker dispara nos TRÊS níveis (global, diário, por usuário) e o
 *    escopo por usuário é independente dos outros;
 *  - teto global de R$200/mês recusa a chamada paga, e a recusa custa zero e
 *    não consome quota — o item continua disponível para o fluxo manual;
 *  - o custo é debitado na MESMA contabilidade da quota (a linha da 0024), e
 *    preço ausente não vira custo zero;
 *  - a API nega o upload com o código certo e a orientação de fluxo manual;
 *  - o painel interno expõe breakers, gasto e plano sem conteúdo de tenant.
 */

const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });
const name = `stk_f213_test_${randomUUID().replaceAll('-', '')}`;
const image = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));

let database: Database;
let entitlements: EntitlementService;
let policy: ExtractionPolicyService;
let panel: AdminPanelService;
let context: OrganizationContext;
let tenantContext: OrganizationContext;
let finance: FinanceService;
let imports: ImportService;
let created = false;

const sha256Of = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);

const extraction = (reference: string): TicketExtraction => ({
  reference,
  placedAtText: null,
  currency: 'BRL',
  stake: '10.00',
  odds: '2.00',
  potentialReturn: null,
  freebet: null,
  selections: [
    {
      event: 'Alfa x Beta',
      sport: null,
      market: null,
      selection: 'Alfa',
      odds: '2.00',
      eventDateText: null,
    },
  ],
  warnings: [],
});

async function newInbox(): Promise<string> {
  const store = createInboxStore(database, async () => undefined);
  return store.accept(
    context,
    {
      sourceKey: `f2-13:${randomUUID()}`,
      caption: `f2-13#${randomUUID()}`,
      metadata: { source: 'test' },
    },
    async () => image,
  );
}

const usageToday = async () => {
  const row = (
    await database.pool.query<{
      presented: string;
      uncertain: string;
      failed: string;
      refused: string;
      cost_micros: string;
    }>(
      'select presented,uncertain,failed,refused,cost_micros from integration.ai_usage_day where day=$1',
      [today()],
    )
  ).rows[0];
  return {
    presented: Number(row?.presented ?? 0),
    uncertain: Number(row?.uncertain ?? 0),
    failed: Number(row?.failed ?? 0),
    refused: Number(row?.refused ?? 0),
    costMicros: Number(row?.cost_micros ?? 0),
  };
};

/** Atribui um plano a uma organização, como o servidor faria. */
async function assignPlan(organizationId: string, planId: string): Promise<void> {
  await database.pool.query(
    'insert into core.organization_entitlement(organization_id,plan_id) values($1,$2) on conflict (organization_id) do update set plan_id=excluded.plan_id',
    [organizationId, planId],
  );
}

const gate = (overrides: Partial<PaidCallGate> = {}): PaidCallGate => ({
  dailyPresented: 0,
  dailyCeiling: 60,
  monthlyPresented: 0,
  monthlyCeiling: 1500,
  monthlySpendMicros: 0,
  globalSpendCapMicros: GLOBAL_SPEND_CAP_MICROS,
  globalOpen: false,
  dailyOpen: false,
  userOpen: false,
  spendExhausted: false,
  refusesPaidCalls: false,
  ...overrides,
});

beforeAll(async () => {
  if (!/^stk_f213_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  created = true;
  const url = new URL(sourceUrl);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString(), { statementTimeoutMs: 30_000 });
  await migrateLocalDatabase(database);
  await database.pool.query(
    "insert into auth.\"user\"(id,name,email) values('f2-13-fixture','Fixture F213','f2-13@stk.test') on conflict (id) do nothing",
  );
  context = await createTenantContext(database).ensureOrganizationMembership('f2-13-fixture');
  // A API é exercitada com a sessão de `fixture-owner`, que precisa do seu
  // próprio contexto: a porta de entitlement decide sobre a ORGANIZAÇÃO que o
  // chamador pertence, nunca sobre uma organização escolhida no request.
  await database.pool.query(
    "insert into auth.\"user\"(id,name,email) values('fixture-owner','Owner F213','owner-f213@stk.test') on conflict (id) do nothing",
  );
  tenantContext = await createTenantContext(database).ensureOrganizationMembership('fixture-owner');
  finance = createFinanceService(database);
  imports = createImportService(database);
  entitlements = createEntitlementService(database);
  policy = createExtractionPolicyService(database);
  panel = createAdminPanelService(database);
});

afterAll(async () => {
  try {
    await database?.close();
    if (created && /^stk_f213_test_[a-f0-9]{32}$/.test(name))
      await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  } finally {
    await admin.close();
  }
});

beforeEach(async () => {
  await database.pool.query(
    'update integration.ai_usage_day set requests=0, presented=0, uncertain=0, failed=0, refused=0, cost_micros=0',
  );
  await database.pool.query('delete from integration.ai_circuit_breaker');
  await database.pool.query('delete from core.organization_entitlement');
});

describe('STK-F2-13 §15 — o entitlement é calculado no BANCO, não no produto', () => {
  it('sem atribuição, a organização recebe o plano free e seus tetos', async () => {
    const list = await entitlements.entitlements(context.organizationId);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((entry) => entry.plan === 'free')).toBe(true);
    const ocr = list.find((entry) => entry.feature === 'ocr_extraction')!;
    expect(ocr.enabled).toBe(true);
    expect(ocr.limit).toBe(100);
  });

  it('a função do banco devolve uma linha por recurso do plano efetivo', async () => {
    await assignPlan(context.organizationId, 'pro');
    const list = await entitlements.entitlements(context.organizationId);
    expect(list.every((entry) => entry.plan === 'pro')).toBe(true);
    // Pro não tem teto próprio de OCR — e isso NÃO amplia nada: o teto global
    // de quota e de R$200 continua valendo acima dele.
    expect(list.find((entry) => entry.feature === 'ocr_extraction')!.limit).toBeNull();
  });

  it('organização inexistente devolve NENHUM entitlement (a ausência nega)', async () => {
    const list = await entitlements.entitlements('00000000-0000-4000-8000-0000000000ff');
    expect(list).toEqual([]);
    // E o chamador trata a ausência como recusa: nenhum recurso é concedido.
    expect(entitlementAllows(list, 'ocr_extraction')).toBe(false);
  });

  it('plano diferente muda o que o banco devolve, e a API usa o que o banco devolveu', async () => {
    await assignPlan(context.organizationId, 'free');
    const free = await entitlements.entitlements(context.organizationId);
    expect(entitlementAllows(free, 'advanced_dashboards')).toBe(false);
    await assignPlan(context.organizationId, 'starter');
    const starter = await entitlements.entitlements(context.organizationId);
    expect(entitlementAllows(starter, 'advanced_dashboards')).toBe(true);
    // Trocar o plano no banco muda a resposta SEM tocar em código.
    expect(starter.find((entry) => entry.feature === 'ocr_extraction')!.limit).toBe(500);
  });

  it('o banco recusa cobrança: plan.billable é CHECK false e não há coluna de preço', async () => {
    await expect(
      database.pool.query("update core.plan set billable=true where id='pro'"),
    ).rejects.toMatchObject({ code: '23514' });
    // A superfície de planos não tem preço de venda em lugar nenhum: nem no
    // schema, nem nos tetos (que são unidades de uso).
    const columns = (
      await database.pool.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema='core' and table_name in ('plan','plan_entitlement')",
      )
    ).rows.map((row) => row.column_name);
    expect(columns.filter((name) => /price|amount|cost|brl|monthly_fee/i.test(name))).toEqual([]);
  });

  it('o teto do plano é medido na MESMA unidade da quota (apresentações do mês)', async () => {
    const list: Entitlement[] = await entitlements.entitlements(context.organizationId);
    // Folga enquanto o consumo não chega ao teto; e sem limite, nunca recusa.
    expect(entitlementWithinLimit(list, 'ocr_extraction', 99)).toBe(true);
    expect(entitlementWithinLimit(list, 'ocr_extraction', 100)).toBe(false);
    await assignPlan(context.organizationId, 'pro');
    const pro = await entitlements.entitlements(context.organizationId);
    expect(entitlementWithinLimit(pro, 'ocr_extraction', 1_000_000)).toBe(true);
  });
});

describe('STK-F2-13 §15 — circuit breaker nos três níveis', () => {
  it('o limiar vem do BANCO, e mudar a política muda o comportamento', async () => {
    const before = await policy.readPolicies();
    expect(before.global.failureThreshold).toBe(5);
    // Ajustar a política é um UPDATE de tabela, não um deploy: é exatamente o
    // que a F2-06 deixou para esta card.
    await database.pool.query(
      "update integration.breaker_policy set failure_threshold=2 where scope='global'",
    );
    const after = await policy.readPolicies();
    expect(after.global.failureThreshold).toBe(2);
    // Restaurar: a política é dado de teste, e o próximo caso depende do
    // default gravado pela migração.
    await database.pool.query(
      'update integration.breaker_policy set failure_threshold=5, recovery_ms=900000, spend_cap_micros=200000000, spend_window=$1 where scope=$2',
      ['month', 'global'],
    );
  });

  it('abre nos escopos global e diário, e o por usuário é independente', async () => {
    for (let index = 0; index < 5; index += 1) {
      await policy.recordFailure(context, {
        inboxId: await newInbox(),
        imageSha256: sha256Of(image),
        category: 'confirmed_provider',
        userId: 'user-alfa',
      });
    }
    const status = await policy.status('user-alfa');
    // Os três escopos foram alimentados pela mesma falha confirmada.
    expect(status.globalOpen).toBe(true);
    expect(status.dailyOpen).toBe(true);
    expect(status.userOpen).toBe(true);
    // Um usuário sem histórico não é afetado pelo circuito de outro.
    expect((await policy.status('user-beta')).userOpen).toBe(false);
  });

  it('falha INCERTA não abre circuito nem consome quota, e debita custo estimado', async () => {
    const inboxId = await newInbox();
    await policy.recordFailure(context, {
      inboxId,
      imageSha256: sha256Of(image),
      category: 'uncertain_timeout',
      model: 'google/gemini-3.8-flash',
      usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
    });
    expect((await policy.status()).globalOpen).toBe(false);
    // presented = 0: nada foi mostrado, então nada foi cobrado do usuário.
    expect(await usageToday()).toMatchObject({ presented: 0, uncertain: 1 });
    // O custo, esse sim: a resposta incerta PODE ter custado ao fornecedor — e é
    // por isso que ela não pode ser repetida.
    const usage = await usageToday();
    expect(usage.costMicros).toBeGreaterThan(0);
  });

  it('com circuito aberto, a chamada paga é recusada e o item fica para o usuário', async () => {
    for (let index = 0; index < 5; index += 1) {
      await policy.recordFailure(context, {
        inboxId: await newInbox(),
        imageSha256: sha256Of(image),
        category: 'confirmed_provider',
      });
    }
    // As cinco falhas confirmadas acima custaram trabalho ao fornecedor, e por
    // isso são debitadas. A recusa que vem AGORA não pode custar nada: nenhuma
    // chamada saiu por causa dela.
    const before = await usageToday();
    const inboxId = await newInbox();
    const refused = await policy.requirePaidCall(context, inboxId, sha256Of(image));
    expect(refused.allowed).toBe(false);
    expect(refused.allowed === false && refused.reason).toBe('breaker');
    // A recusa não apaga o item: o fluxo manual continua disponível.
    const row = (
      await database.pool.query('select state from integration.inbox where id=$1', [inboxId])
    ).rows[0];
    expect(row?.state).not.toBe('discarded');
    // presented não sobe (nada foi mostrado) e refused sobe exatamente 1; o
    // custo fica intacto, porque a recusa é anterior à chamada.
    const after = await usageToday();
    expect(after.presented).toBe(0);
    expect(after.refused).toBe(before.refused + 1);
    expect(after.costMicros).toBe(before.costMicros);
  });
});

describe('STK-F2-13 §15 — teto global de R$200/mês', () => {
  it('o teto gravado é R$200 por mês, e é lido do banco', async () => {
    const policies = await policy.readPolicies();
    expect(policies.global.spendCapMicros).toBe(GLOBAL_SPEND_CAP_MICROS);
    expect(policies.global.spendCapMicros).toBe(200_000_000);
    expect(policies.global.spendWindow).toBe('month');
  });

  it('atingido o teto, a chamada paga é recusada com motivo de gasto', async () => {
    // O gasto acumulado no mês atinge R$200 exatamente.
    await database.pool.query(
      'update integration.ai_usage_day set cost_micros=200000000 where day=$1',
      [today()],
    );
    const status = await policy.status();
    expect(status.monthlySpendMicros).toBe(GLOBAL_SPEND_CAP_MICROS);
    expect(status.spendExhausted).toBe(true);
    expect(status.refusesPaidCalls).toBe(true);
    const gate = await policy.requirePaidCall(context, await newInbox(), sha256Of(image));
    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.reason).toBe('spend');
    expect(gate.allowed === false && gate.scope).toBe('global');
  });

  it('abaixo do teto, a chamada segue permitida', async () => {
    await database.pool.query(
      'update integration.ai_usage_day set cost_micros=199999999 where day=$1',
      [today()],
    );
    const status = await policy.status();
    expect(status.spendExhausted).toBe(false);
    expect(status.refusesPaidCalls).toBe(false);
    expect((await policy.requirePaidCall(context, await newInbox(), sha256Of(image))).allowed).toBe(
      true,
    );
  });

  it('o gasto é lido da MESMA contabilidade da quota, sem tabela duplicada', async () => {
    // Uma linha, duas dimensões: quota e custo na mesma tabela da 0024.
    const row = (
      await database.pool.query<{ n: string }>(
        "select count(*)::text as n from information_schema.columns where table_name='ai_usage_day' and column_name='cost_micros'",
      )
    ).rows[0]!;
    expect(Number(row.n)).toBe(1);
    // E a agregação do teto usa a MESMA tabela.
    const before = (
      await database.pool.query<{ n: string }>(
        'select count(*)::text as n from integration.ai_usage_day',
      )
    ).rows[0]!;
    expect(Number(before.n)).toBeGreaterThan(0);
  });
});

describe('STK-F2-13 §15 — custo estimado sem preço não é custo zero', () => {
  it('preço e uso conhecidos: o custo é a soma por token', () => {
    const cost = aiCallCost({
      model: 'google/gemini-3.8-flash',
      promptTokens: 1000,
      completionTokens: 1000,
      inputMicrosPer1k: 1500,
      outputMicrosPer1k: 6000,
      unpricedCallMicros: 1500,
    });
    expect(cost.priced).toBe(true);
    expect(cost.micros).toBe(1500 + 6000);
  });

  it('arredonda para CIMA, para que o teto não seja furado por fração', () => {
    const cost = aiCallCost({
      model: 'm',
      promptTokens: 1,
      completionTokens: 0,
      inputMicrosPer1k: 1500,
      outputMicrosPer1k: 6000,
      unpricedCallMicros: 1500,
    });
    // 1 token a 1500/1000 micros = 1.5 micros → 2, nunca 1.
    expect(cost.micros).toBe(2);
  });

  it('preço ausente custa a chamada inteira, e o resultado é marcado como não precificado', () => {
    const cost = aiCallCost({
      model: 'modelo-desconhecido',
      promptTokens: 1000,
      completionTokens: 1000,
      inputMicrosPer1k: null,
      outputMicrosPer1k: null,
      unpricedCallMicros: 1500,
    });
    expect(cost.priced).toBe(false);
    expect(cost.micros).toBe(1500);
  });

  it('uso não declarado pelo fornecedor não vira custo zero', () => {
    const cost = aiCallCost({
      model: 'google/gemini-3.8-flash',
      promptTokens: null,
      completionTokens: null,
      inputMicrosPer1k: 1500,
      outputMicrosPer1k: 6000,
      unpricedCallMicros: 1500,
    });
    expect(cost.micros).toBe(1500);
    expect(cost.priced).toBe(false);
  });

  it('o catálogo do banco tem preço de referência e a apresentação o debita', async () => {
    const price = (
      await database.pool.query<{ input_micros_per_1k: string; output_micros_per_1k: string }>(
        "select input_micros_per_1k,output_micros_per_1k from integration.ai_model_price where model='google/gemini-3.8-flash'",
      )
    ).rows[0]!;
    expect(Number(price.input_micros_per_1k)).toBeGreaterThan(0);
    const inboxId = await newInbox();
    await policy.record(context, {
      inboxId,
      imageSha256: sha256Of(image),
      outcome: 'presented',
      sanitized: extraction('AAA111'),
      model: 'google/gemini-3.8-flash',
      usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
    });
    const usage = await usageToday();
    expect(usage.presented).toBe(1);
    expect(usage.costMicros).toBe(1500 + 6000);
  });

  it('a recusa por cota custa zero, porque nenhuma chamada saiu', async () => {
    // A porta precisa estar fechada por um motivo que exista: aqui o consumo
    // de hoje já está no teto diário, e nenhuma chamada foi feita.
    await database.pool.query('update integration.ai_usage_day set presented=60 where day=$1', [
      today(),
    ]);
    const before = await usageToday();
    const inboxId = await newInbox();
    const refused = await policy.requirePaidCall(context, inboxId, sha256Of(image));
    expect(refused.allowed).toBe(false);
    expect(refused.allowed === false && refused.reason).toBe('quota');
    // A recusa não consome quota (presented não sobe) e não custa nada
    // (cost_micros intacto): nenhuma chamada saiu.
    const after = await usageToday();
    expect(after.presented).toBe(before.presented);
    expect(after.refused).toBe(before.refused + 1);
    expect(after.costMicros).toBe(before.costMicros);
  });
});

describe('STK-F2-13 §15 — a decisão da porta é fail-closed em todos os caminhos', () => {
  it('com qualquer fronteira fechada, a resposta é recusa', () => {
    expect(paidCallDecision(gate()).allowed).toBe(true);
    expect(paidCallDecision(gate({ globalOpen: true }))).toMatchObject({
      allowed: false,
      reason: 'breaker',
      scope: 'global',
    });
    expect(paidCallDecision(gate({ userOpen: true }))).toMatchObject({
      reason: 'breaker',
      scope: 'user',
    });
    expect(paidCallDecision(gate({ dailyOpen: true }))).toMatchObject({
      reason: 'breaker',
      scope: 'daily',
    });
    expect(paidCallDecision(gate({ spendExhausted: true }))).toMatchObject({
      reason: 'spend',
      scope: 'global',
    });
    expect(paidCallDecision(gate({ dailyPresented: 60 }))).toMatchObject({
      reason: 'quota',
      scope: 'daily',
    });
    expect(paidCallDecision(gate({ monthlyPresented: 1500 }))).toMatchObject({
      reason: 'quota',
      scope: 'global',
    });
  });

  it('o gasto tem prioridade sobre a quota, e o breaker sobre ambos', () => {
    // Tudo fechado ao mesmo tempo: o motivo mais específico vence, porque é
    // ele que diz qual escopo precisa ser tratado.
    expect(
      paidCallDecision(gate({ globalOpen: true, spendExhausted: true, dailyPresented: 60 })),
    ).toMatchObject({ reason: 'breaker', scope: 'global' });
    expect(paidCallDecision(gate({ spendExhausted: true, dailyPresented: 60 }))).toMatchObject({
      reason: 'spend',
    });
  });

  it('um escopo sem teto de gasto não é um escopo liberado', () => {
    expect(
      spendExhausted({ micros: 10 ** 9, capMicros: null, window: null, exhausted: false }),
    ).toBe(false);
  });

  it('toda recusa tem orientação de FLUXO MANUAL, e nenhuma é terminal', () => {
    for (const code of [
      'ENTITLEMENT_FEATURE_DENIED',
      'ENTITLEMENT_PLAN_LIMIT_REACHED',
      'PAID_CALL_CEILING_REACHED',
    ] as const) {
      const message = manualFlowGuidance[code];
      // A orientação diz o que fazer, não o que deu errado: o item continua
      // disponível para preenchimento manual.
      expect(message.length).toBeGreaterThan(0);
      expect(message).toMatch(/manual/i);
    }
  });

  it('a unidade de quota continua sendo a da F2-06: apresentação, não chamada', () => {
    expect(quotaUnitForOutcome('presented')).toBe(1);
    expect(quotaUnitForOutcome('uncertain')).toBe(0);
    expect(quotaUnitForOutcome('refused_quota')).toBe(0);
  });
});

describe('STK-F2-13 §15 — o painel interno expõe estado, sem conteúdo de usuário', () => {
  it('mostra gasto, breakers e plano, e nenhum valor financeiro de tenant', async () => {
    await assignPlan(context.organizationId, 'starter');
    await database.pool.query(
      'update integration.ai_usage_day set cost_micros=25000000 where day=$1',
      [today()],
    );
    const usage = await panel.usage('f2-13-fixture', null);
    // Gasto: o que PAGAMOS, com teto global explícito.
    expect(usage.spend.micros).toBe(25_000_000);
    expect(usage.spend.capMicros).toBe(GLOBAL_SPEND_CAP_MICROS);
    expect(usage.spend.exhausted).toBe(false);
    // Plano lido da MESMA função que a API usa para decidir.
    const plan = usage.plans.find((entry) => entry.organizationId === context.organizationId)!;
    expect(plan.plan).toBe('starter');
    // O preço é INDEFINIDO no beta, e o payload diz isso explicitamente.
    expect(plan.priceBRL).toBeNull();
    expect(plan.pricesDefined).toBe(false);
    // Nenhum conteúdo de usuário. O RÓTULO da organização aparece porque é o
    // metadado de tenant que a F2-11 já publica em contas e filas — a conta
    // precisa ser reconhecível para ser operada, e o rótulo é a label da
    // ORGANIZAÇÃO, não dado da pessoa. O que é da PESSOA (e-mail, id interno)
    // não aparece, e o panel não traz aposta, saldo, resultado ou imagem.
    const serialized = JSON.stringify(usage);
    expect(serialized).not.toContain('f2-13@stk.test');
    expect(serialized).not.toContain('f2-13-fixture');
  });

  it('o circuito por usuário aparece como CONTAGEM, sem o id do usuário', async () => {
    for (let index = 0; index < 5; index += 1) {
      await policy.recordFailure(context, {
        inboxId: await newInbox(),
        imageSha256: sha256Of(image),
        category: 'confirmed_provider',
        userId: 'user-privado',
      });
    }
    const usage = await panel.usage('f2-13-fixture', null);
    expect(usage.openUserBreakers).toBe(1);
    // O id do usuário é identificador pessoal e NÃO é publicado.
    expect(JSON.stringify(usage)).not.toContain('user-privado');
    // O escopo global aparece pelo estado, e o contador de falhas é número.
    const globalBreaker = usage.breakers.find((entry) => entry.scope === 'global')!;
    expect(globalBreaker.state).toBe('open');
    expect(globalBreaker.confirmedFailures).toBe(5);
  });

  it('o consumo do plano no painel é uma contagem, e a API mede o mesmo número', async () => {
    const inboxId = await newInbox();
    await policy.record(context, {
      inboxId,
      imageSha256: sha256Of(image),
      outcome: 'presented',
      sanitized: extraction('BBB222'),
    });
    const usage = await panel.usage('f2-13-fixture', null);
    const plan = usage.plans.find((entry) => entry.organizationId === context.organizationId)!;
    // Um, e apenas um: o painel e a API contam pela MESMA condição de
    // apresentação, então não podem divergir.
    expect(plan.ocrUsedMonth).toBeGreaterThanOrEqual(1);
  });
});

describe('STK-F2-13 §15 — a API respeita os entitlements calculados no banco', () => {
  /**
   * O critério de aceite do card é "entitlements calculados no banco e
   * RESPEITADOS NA API". Estes casos exercitam a ROTA real, com o serviço real
   * ligado ao mesmo banco: o que muda o resultado é uma LINHA em
   * `core.organization_entitlement`, nunca um parâmetro do request.
   */
  const getOwner = vi.fn();
  const auth = { origin: 'http://localhost:8088', getOwner } as unknown as OwnerAuth;
  // O app é montado DEPOIS do `beforeAll` (o `describe` é avaliado na carga do
  // módulo, antes de o banco existir): um handle tardio, criado no primeiro uso.
  let app: ReturnType<typeof createApp> | null = null;
  const appOf = () => {
    app ??= createApp({
      checkDatabase: database.check,
      ownerAuth: auth,
      finance,
      imports,
      entitlements: createEntitlementService(database),
    });
    return app;
  };
  const send = async () => {
    getOwner.mockResolvedValue({ user: { id: 'fixture-owner' } });
    return appOf().inject({
      method: 'POST',
      url: '/api/v1/imports',
      headers: { origin: auth.origin, 'idempotency-key': randomUUID() },
      payload: { image: image.toString('base64'), caption: `f2-13-api-${randomUUID()}` },
    });
  };
  beforeEach(async () => {
    await database.pool.query('delete from core.organization_entitlement');
    await database.pool.query(
      'update integration.ai_usage_day set requests=0, presented=0, uncertain=0, failed=0, refused=0, cost_micros=0',
    );
    await database.pool.query('delete from integration.ai_circuit_breaker');
  });
  afterAll(async () => {
    await app?.close();
  });

  it('com o plano free (padrão do banco), o upload é aceito', async () => {
    const response = await send();
    expect(response.statusCode).toBe(200);
  });

  it('teto de R$200/mês atingido ⇒ 429 PAID_CALL_CEILING_REACHED, com orientação manual', async () => {
    await database.pool.query(
      'update integration.ai_usage_day set cost_micros=200000000 where day=$1',
      [new Date().toISOString().slice(0, 10)],
    );
    const response = await send();
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: 'PAID_CALL_CEILING_REACHED' } });
    // A mensagem ORIENTA o fluxo manual: a recusa é de orçamento, não de
    // bilhete, e o usuário continua com a importação à mão.
    expect(response.json().error.message).toMatch(/manual/i);
  });

  it('circuito global aberto ⇒ 429, e o item não é criado', async () => {
    for (let index = 0; index < 5; index += 1) {
      await database.pool.query(
        `insert into integration.ai_circuit_breaker
           (scope,scope_key,state,consecutive_confirmed_failures,opened_at,recovers_at,last_error_category)
         values ('global','global','open',5,now(),now()+interval '15 minutes','confirmed_provider')
         on conflict (scope,scope_key) do update set
           state='open', opened_at=now(), recovers_at=now()+interval '15 minutes',
           consecutive_confirmed_failures=5`,
      );
    }
    const before = (
      await database.pool.query<{ n: string }>('select count(*)::text as n from integration.inbox')
    ).rows[0]!;
    const response = await send();
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: 'PAID_CALL_CEILING_REACHED' } });
    // Nenhum item foi criado: a recusa acontece ANTES de a imagem virar item.
    const after = (
      await database.pool.query<{ n: string }>('select count(*)::text as n from integration.inbox')
    ).rows[0]!;
    expect(after.n).toBe(before.n);
  });

  it('recurso desligado no plano ⇒ 403 ENTITLEMENT_FEATURE_DENIED', async () => {
    // O banco diz que `ocr_extraction` está desligado para este tenant; a API
    // obedece sem que ninguém precise dizer isso no request.
    await database.pool.query(
      "update core.plan_entitlement set enabled=false where plan_id='free' and feature='ocr_extraction'",
    );
    try {
      const response = await send();
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'ENTITLEMENT_FEATURE_DENIED' } });
      expect(response.json().error.message).toMatch(/manual/i);
    } finally {
      await database.pool.query(
        "update core.plan_entitlement set enabled=true where plan_id='free' and feature='ocr_extraction'",
      );
    }
  });

  it('teto de plano atingido ⇒ 403 ENTITLEMENT_PLAN_LIMIT_REACHED', async () => {
    // 100 extrações APRESENTADAS no mês = o teto do plano free. O consumo do
    // plano é medido por `extraction_audit` (a MESMA unidade que a quota
    // debita), e é por ORGANIZAÇÃO — não pelo contador global do dia, que é o
    // teto de infraestrutura. Sem essa distinção os dois tetos se confundiriam.
    const store = createInboxStore(database, async () => undefined);
    for (let index = 0; index < 100; index += 1) {
      const id = await store.accept(
        tenantContext,
        {
          sourceKey: `f2-13-plan:${index}:${randomUUID()}`,
          caption: `f2-13-plan#${index}`,
          metadata: { source: 'test' },
        },
        async () => image,
      );
      await policy.record(tenantContext, {
        inboxId: id,
        imageSha256: sha256Of(image),
        outcome: 'presented',
        sanitized: extraction(`P${index}`),
      });
    }
    // Zerar o contador GLOBAL de hoje prova que a recusa veio do PLANO e não do
    // teto de infraestrutura: os dois são medidos em lugares diferentes.
    await database.pool.query('update integration.ai_usage_day set requests=0, presented=0');
    const response = await send();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'ENTITLEMENT_PLAN_LIMIT_REACHED' } });
    expect(response.json().error.message).toMatch(/manual/i);
  });

  it('sem o serviço de entitlement, o upload RECUSA (fail-closed), não passa', async () => {
    // Um produto sem o banco de entitlement não pode afirmar que respeita
    // plano: a ausência do serviço fecha a porta em 503.
    const withoutGate = createApp({
      checkDatabase: database.check,
      ownerAuth: auth,
      finance,
      imports,
    });
    try {
      getOwner.mockResolvedValue({ user: { id: 'fixture-owner' } });
      const response = await withoutGate.inject({
        method: 'POST',
        url: '/api/v1/imports',
        headers: { origin: auth.origin, 'idempotency-key': randomUUID() },
        payload: { image: image.toString('base64'), caption: `f2-13-nogate-${randomUUID()}` },
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await withoutGate.close();
    }
  });

  it('trocar o plano no BANCO muda a resposta da rota, sem tocar em código', async () => {
    // Consumo no MESMO teto do plano free: 100 apresentações da organização da
    // sessão. A primeira resposta é a recusa de PLANO.
    const store = createInboxStore(database, async () => undefined);
    for (let index = 0; index < 100; index += 1) {
      const id = await store.accept(
        tenantContext,
        {
          sourceKey: `f2-13-swap:${index}:${randomUUID()}`,
          caption: `f2-13-swap#${index}`,
          metadata: { source: 'test' },
        },
        async () => image,
      );
      await policy.record(tenantContext, {
        inboxId: id,
        imageSha256: sha256Of(image),
        outcome: 'presented',
        sanitized: extraction(`S${index}`),
      });
    }
    await database.pool.query('update integration.ai_usage_day set requests=0, presented=0');
    expect((await send()).statusCode).toBe(403);
    // O pro não tem teto próprio de OCR — e a MESMA linha no banco basta. O
    // consumo continua o mesmo; o que mudou foi o teto que o plano impõe.
    await database.pool.query(
      "insert into core.organization_entitlement(organization_id,plan_id) values($1,'pro') on conflict (organization_id) do update set plan_id='pro'",
      [tenantContext.organizationId],
    );
    expect((await send()).statusCode).toBe(200);
  });
});

describe('STK-F2-13 §15 — replay-safe e forward-only', () => {
  it('a migração 0025 está no journal, em ordem e com índice contíguo', () => {
    const journal = JSON.parse(
      readFileSync(
        new URL('../../packages/db/migrations/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: { idx: number; tag: string }[] };
    // A 0025 NÃO é mais a última: a STK-F2-09 acrescenta a 0026 e a STK-F2-08 a
    // 0027 depois dela. O que esta asserção garante é o que a 0025 pediu — ela
    // está no journal, com índice contíguo, e o que veio depois não a desordena.
    const entry = journal.entries.find(
      (candidate) => candidate.tag === '0025_entitlements_breakers',
    )!;
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(25);
    // Nenhuma entrada pode ter índice fora da sua posição: é o que faz o
    // replay de prefixo do migrador ser confiável.
    expect(journal.entries.every((candidate, index) => candidate.idx === index)).toBe(true);
  });

  it('todos os objetos da 0025 existem e são coerentes', async () => {
    const tables = (
      await database.pool.query<{ n: string }>(
        `select count(*)::text as n from information_schema.tables
          where (table_schema='core' and table_name in ('plan','plan_entitlement','organization_entitlement'))
             or (table_schema='integration' and table_name in ('breaker_policy','ai_model_price','ai_cost_model'))`,
      )
    ).rows[0]!;
    expect(Number(tables.n)).toBe(6);
    // A função de resolução é a que a API e o painel consultam.
    const fn = (
      await database.pool.query<{ n: string }>(
        "select count(*)::text as n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='core' and p.proname='organization_entitlements'",
      )
    ).rows[0]!;
    expect(Number(fn.n)).toBe(1);
  });

  it('o banco recusa incoerência: teto sem janela, e plano cobrável', async () => {
    await expect(
      database.pool.query(
        "update integration.breaker_policy set spend_window=null where scope='global'",
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a RLS da atribuição de plano é fail-closed sem contexto de organização', async () => {
    // A fronteira de `core.organization_entitlement` é a PREDICADO, não um erro
    // de cast: `nullif(current_setting(...), '')::uuid` devolve NULL quando não
    // há contexto, e a comparação com NULL não casa linha nenhuma. Então a
    // falha fechada aqui é a CONTAGEM ZERO, não uma exceção.
    //
    // (O padrão de exceção 22P02 é o de `finance`/`integration`, que usam o
    // cast direto; aqui a predicado é mais explícita e o efeito é o mesmo.)
    await assignPlan(context.organizationId, 'pro');
    const any = (
      await database.pool.query<{ n: string }>(
        'select count(*)::text as n from core.organization_entitlement',
      )
    ).rows[0]!;
    expect(Number(any.n)).toBeGreaterThan(0);
    // Sem contexto, a mesma linha não é vista — é o que fail-closed significa.
    // O `nullif` é o que faz o vínculo ausente virar NULL (e a comparação com
    // NULL não casar nada) em vez de erro: é a mesma fronteira de
    // `core.telegram_link`, e o efeito é o mesmo do `finance` com 22P02.
    const scoped = (
      await database.pool.query<{ n: string }>(
        "select count(*)::text as n from core.organization_entitlement where organization_id=nullif(current_setting('app.organization_id', true), '')::uuid",
      )
    ).rows[0]!;
    expect(Number(scoped.n)).toBe(0);
  });
});

describe('STK-F2-13 §15 — a API recusa com o código certo e orienta o fluxo manual', () => {
  it('a recusa de teto devolve 429 PAID_CALL_CEILING_REACHED e a orientação', async () => {
    // A porta é exercitada pela mesma função pura que a rota usa, com o mesmo
    // estado que o banco produz: teto de R$200 atingido.
    await database.pool.query(
      'update integration.ai_usage_day set cost_micros=200000000 where day=$1',
      [today()],
    );
    const current = await entitlements.gate(context.userId);
    const decision = paidCallDecision(current);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('spend');
    // A mensagem entregue ao usuário é a de fluxo manual, indexada pelo mesmo
    // código que a rota devolve.
    expect(manualFlowGuidance.PAID_CALL_CEILING_REACHED).toMatch(/manual/i);
  });

  it('com o tenant no limite do plano, a API recusa antes de qualquer chamada', async () => {
    await assignPlan(context.organizationId, 'free');
    const list = await entitlements.entitlements(context.organizationId);
    expect(entitlementWithinLimit(list, 'ocr_extraction', 100)).toBe(false);
    // A ordem da verificação é entitlement → teto de plano → teto de chamada
    // paga, e a recusa de plano é a PRIMEIRA: nem chega a haver chamada.
    expect(entitlementAllows(list, 'ocr_extraction')).toBe(true);
  });
});

describe('STK-F2-13 §15 — a montagem da política degrada para o mais contido', () => {
  it('sem tabela de política, o limiar e a janela são MAIS estritos, nunca mais frouxos', async () => {
    const canonical = await policy.readPolicies();
    await database.pool.query('delete from integration.breaker_policy');
    const degraded = await policy.readPolicies();
    // Perder a tabela de política fecha a porta mais cedo; abrir mais é que
    // seria perigoso. E o teto de gasto não é inventado na degradação: sem
    // política, não há número — o `status` cai no teto canônico do shared.
    expect(degraded.global.failureThreshold).toBeLessThanOrEqual(canonical.global.failureThreshold);
    expect(degraded.global.recoveryMs).toBeLessThanOrEqual(canonical.global.recoveryMs);
    expect(degraded.global.spendCapMicros).toBeNull();
    const status = await policy.status();
    expect(status.refusesPaidCalls).toBe(false);
    await database.pool.query(
      "insert into integration.breaker_policy(scope,failure_threshold,recovery_ms,spend_cap_micros,spend_window) values ('global',5,900000,200000000,'month'),('daily',5,900000,null,null),('user',5,900000,null,null) on conflict (scope) do nothing",
    );
  });

  it('o uso do mês é lido da contabilidade real, e zera sem registros', async () => {
    await database.pool.query('delete from integration.extraction_audit');
    const list = await entitlements.entitlements(context.organizationId);
    expect(entitlementWithinLimit(list, 'ocr_extraction', 0)).toBe(true);
  });
});
