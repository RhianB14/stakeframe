import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_CIRCUIT_FAILURE_THRESHOLD,
  createDatabase,
  createExtractionPolicyService,
  createInboxStore,
  createTenantContext,
  requireDatabaseUrl,
  secondaryAllowedAfter,
  type Database,
  type ExtractionPolicyService,
  type OrganizationContext,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { extractUnderPolicy } from '../../apps/worker/src/extraction-policy.js';
import { TICKET_EXTRACTION_SYSTEM_PROMPT } from '../../apps/worker/src/openrouter.js';
import {
  EXTRACTION_PIPELINE_VERSION,
  OPENROUTER_MODEL,
  extractionAuditRecordSchema,
  quotaUnitForOutcome,
  type TicketExtraction,
} from '../../packages/shared/src/index.js';

/**
 * STK-F2-06 §15 — extração fail-closed, persistência sanitizada e cota.
 *
 * PostgreSQL real, banco descartável, dados fictícios. Nenhuma chamada ao
 * OpenRouter, nenhuma credencial e nenhum conteúdo de bilhete em log.
 *
 * O que estes testes provam:
 *  - falha técnica (timeout, conexão perdida) NÃO consome cota e NÃO abre o
 *    circuito; a falha confirmada consome breaker, não cota;
 *  - a cota é debitada quando a extração é APRESENTADA, e uma segunda
 *    apresentação do MESMO item não a debita de novo (o banco, não a aplicação);
 *  - teto atingido recusa a chamada paga, devolve o item para preenchimento
 *    manual e não consome cota;
 *  - dois resultados válidos ficam registrados como `candidates_pending`, com
 *    `selected` nulo: nada é escolhido automaticamente;
 *  - NADA de prompt ou resposta bruta é persistido — a validação é o schema
 *    estrito, e um payload com texto bruto é rejeitado;
 *  - o circuito abre por falhas CONFIRMADAS, nos três escopos, e o escopo por
 *    usuário é independente do global.
 */
const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });
const name = `stk_f206_test_${randomUUID().replaceAll('-', '')}`;
const image = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));

let database: Database;
let policy: ExtractionPolicyService;
let context: OrganizationContext;
let created = false;

const sha256Of = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Estrutura sanitizada válida: a mesma forma que o modelo devolve. */
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

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Resposta sintética do OpenRouter. `content` é o JSON da extração — é o que a
 * política recebe, e o registro guarda só a ESTRUTURA e o hash do texto.
 */
const completion = {
  id: 'f2-06-test-completion',
  model: OPENROUTER_MODEL,
  provider: 'Google AI Studio',
  choices: [
    {
      finish_reason: 'stop',
      message: { content: JSON.stringify(extraction('Z9Z9Z9Z9')) },
    },
  ],
  usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
};
/** Formato aceito por `readAiConfig`; nenhuma chamada real sai nos testes. */
const API_KEY = `sk-or-v1-${'a'.repeat(64)}`;

/**
 * Cria um rascunho pelo caminho real de recebimento (o mesmo `createInboxStore`
 * que o worker usa), com legenda própria: a identidade determinística da 0023
 * é (bytes, legenda), e legenda repetida viraria duplicata.
 */
async function newInbox(): Promise<string> {
  const store = createInboxStore(database, async () => undefined);
  return store.accept(
    context,
    {
      sourceKey: `f2-06:${randomUUID()}`,
      caption: `f2-06#${randomUUID()}`,
      metadata: { source: 'test' },
    },
    async () => image,
  );
}

beforeAll(async () => {
  if (!/^stk_f206_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  created = true;
  const url = new URL(sourceUrl);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString(), { statementTimeoutMs: 30_000 });
  await migrateLocalDatabase(database);
  await database.pool.query(
    "insert into auth.\"user\"(id,name,email) values('f2-06-fixture','Fixture F206','f2-06@stk.test') on conflict (id) do nothing",
  );
  context = await createTenantContext(database).ensureOrganizationMembership('f2-06-fixture');
  policy = createExtractionPolicyService(database);
});

afterAll(async () => {
  try {
    await database?.close();
    if (created && /^stk_f206_test_[a-f0-9]{32}$/.test(name))
      await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  } finally {
    await admin.close();
  }
});

beforeEach(async () => {
  // Isolar a quota e o circuito entre casos: cada um começa do zero.
  await database.pool.query(
    'update integration.ai_usage_day set requests=0, presented=0, uncertain=0, failed=0, refused=0',
  );
  await database.pool.query('delete from integration.ai_circuit_breaker');
});

describe('STK-F2-06 §15 — cota contada somente quando a extração é apresentada', () => {
  it('uma falha técnica não consome cota', async () => {
    const inboxId = await newInbox();
    await policy.recordFailure(context, {
      inboxId,
      imageSha256: sha256Of(image),
      category: 'uncertain_timeout',
    });
    const day = (
      await database.pool.query(
        'select presented,uncertain,requests from integration.ai_usage_day where day=$1',
        [today()],
      )
    ).rows[0];
    // presented = 0: nada foi mostrado, então nada foi cobrado do usuário.
    expect(Number(day?.presented)).toBe(0);
    expect(Number(day?.uncertain)).toBe(1);
    expect(Number(day?.requests)).toBe(0);
  });

  it('uma falha confirmada também não consome cota, mas alimenta o circuito', async () => {
    const inboxId = await newInbox();
    await policy.recordFailure(context, {
      inboxId,
      imageSha256: sha256Of(image),
      category: 'confirmed_provider',
    });
    const day = (
      await database.pool.query(
        'select presented,failed,requests from integration.ai_usage_day where day=$1',
        [today()],
      )
    ).rows[0];
    expect(Number(day?.presented)).toBe(0);
    expect(Number(day?.failed)).toBe(1);
    expect(Number(day?.requests)).toBe(0);
    const breaker = (
      await database.pool.query(
        'select consecutive_confirmed_failures,state from integration.ai_circuit_breaker where scope=$1',
        ['global'],
      )
    ).rows[0];
    expect(Number(breaker?.consecutive_confirmed_failures)).toBe(1);
    expect(breaker?.state).toBe('closed');
  });

  it('a apresentação consome exatamente uma unidade', async () => {
    const inboxId = await newInbox();
    await policy.record(context, {
      inboxId,
      imageSha256: sha256Of(image),
      outcome: 'presented',
      sanitized: extraction('AAA111'),
    });
    const day = (
      await database.pool.query(
        'select presented,requests from integration.ai_usage_day where day=$1',
        [today()],
      )
    ).rows[0];
    expect(Number(day?.presented)).toBe(1);
    expect(Number(day?.requests)).toBe(1);
  });

  it('apresentar o mesmo item de novo não debita uma segunda unidade', async () => {
    const inboxId = await newInbox();
    await policy.record(context, {
      inboxId,
      imageSha256: sha256Of(image),
      outcome: 'presented',
      sanitized: extraction('BBB222'),
    });
    await policy.record(context, {
      inboxId,
      imageSha256: sha256Of(image),
      outcome: 'presented',
      sanitized: extraction('CCC333'),
    });
    const day = (
      await database.pool.query('select presented from integration.ai_usage_day where day=$1', [
        today(),
      ])
    ).rows[0];
    // O índice parcial `extraction_audit_presented_idx` impede a contagem dupla
    // no BANCO: a segunda apresentação vira linha de auditoria, não debitada.
    expect(Number(day?.presented)).toBe(1);
  });

  it('dois resultados válidos contam uma unidade e não elegem nenhum', async () => {
    const inboxId = await newInbox();
    await policy.record(context, {
      inboxId,
      imageSha256: sha256Of(image),
      outcome: 'candidates_pending',
      candidates: [extraction('DDD444'), extraction('EEE555')],
    });
    const row = (
      await database.pool.query(
        'select outcome,candidates,selected,outcome_presented from integration.extraction_audit where inbox_id=$1',
        [inboxId],
      )
    ).rows[0];
    expect(row?.outcome).toBe('candidates_pending');
    // Ambos apresentados…
    expect(row?.candidates).toHaveLength(2);
    // …e NENHUM escolhido: a escolha é do usuário, não do servidor.
    expect(row?.selected).toBeNull();
    const day = (
      await database.pool.query('select presented from integration.ai_usage_day where day=$1', [
        today(),
      ])
    ).rows[0];
    expect(Number(day?.presented)).toBe(1);
  });

  it('a cota é função do desfecho, não da chamada', () => {
    expect(quotaUnitForOutcome('presented')).toBe(1);
    expect(quotaUnitForOutcome('candidates_pending')).toBe(1);
    expect(quotaUnitForOutcome('uncertain')).toBe(0);
    expect(quotaUnitForOutcome('confirmed_failure')).toBe(0);
    expect(quotaUnitForOutcome('refused_quota')).toBe(0);
  });
});

describe('STK-F2-06 §15 — teto recusando e item preservado para o usuário', () => {
  it('atingido o teto, a chamada paga é recusada e o item não é gasto', async () => {
    const inboxId = await newInbox();
    await database.pool.query(
      `insert into integration.ai_usage_day(day,requests,presented) values($1,60,60)
       on conflict(day) do update set presented=60, requests=60`,
      [today()],
    );
    const gate = await policy.requirePaidCall(context, inboxId, sha256Of(image));
    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.reason).toBe('quota');
    // O item continua lá: a recusa é de orçamento, não defeito do bilhete.
    const row = (
      await database.pool.query('select state from integration.inbox where id=$1', [inboxId])
    ).rows[0];
    expect(row?.state).not.toBe('discarded');
    const day = (
      await database.pool.query(
        'select presented,refused from integration.ai_usage_day where day=$1',
        [today()],
      )
    ).rows[0];
    // presented não subiu pela recusa: nenhuma chamada foi feita.
    expect(Number(day?.presented)).toBe(60);
    expect(Number(day?.refused)).toBe(1);
  });

  it('o status expõe a cota e os três breakers', async () => {
    const current = await policy.status();
    expect(current.dailyCeiling).toBe(60);
    expect(current.monthlyCeiling).toBe(1500);
    expect(current.refusesPaidCalls).toBe(false);
    expect(current.globalOpen).toBe(false);
  });
});

describe('STK-F2-06 §15 — circuit breaker por falhas confirmadas', () => {
  it('abre o circuito global na quinta falha confirmada, e não antes', async () => {
    for (let index = 0; index < AI_CIRCUIT_FAILURE_THRESHOLD - 1; index += 1) {
      const inboxId = await newInbox();
      await policy.recordFailure(context, {
        inboxId,
        imageSha256: sha256Of(image),
        category: 'confirmed_provider',
      });
      expect((await policy.status()).globalOpen).toBe(false);
    }
    const inboxId = await newInbox();
    await policy.recordFailure(context, {
      inboxId,
      imageSha256: sha256Of(image),
      category: 'confirmed_provider',
    });
    expect((await policy.status()).globalOpen).toBe(true);
    // Com o circuito aberto, a próxima chamada paga é recusada.
    const gate = await policy.requirePaidCall(context, await newInbox(), sha256Of(image));
    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.reason).toBe('breaker');
  });

  it('falha incerta NÃO abre o circuito', async () => {
    for (let index = 0; index < AI_CIRCUIT_FAILURE_THRESHOLD + 2; index += 1) {
      const inboxId = await newInbox();
      await policy.recordFailure(context, {
        inboxId,
        imageSha256: sha256Of(image),
        category: 'uncertain_timeout',
      });
    }
    const current = await policy.status();
    expect(current.globalOpen).toBe(false);
    expect(current.refusesPaidCalls).toBe(false);
  });

  it('o escopo por usuário é independente do global', async () => {
    for (let index = 0; index < AI_CIRCUIT_FAILURE_THRESHOLD; index += 1) {
      const inboxId = await newInbox();
      await policy.recordFailure(context, {
        inboxId,
        imageSha256: sha256Of(image),
        category: 'confirmed_provider',
        userId: 'user-alfa',
      });
    }
    // O usuário tem circuito aberto…
    expect((await policy.status('user-alfa')).userOpen).toBe(true);
    // …e o global também (a falha confirmada alimenta os três escopos).
    expect((await policy.status('user-alfa')).globalOpen).toBe(true);
    // Um usuário sem histórico não é afetado pelo breaker de outro.
    expect((await policy.status('user-beta')).userOpen).toBe(false);
  });

  it('o secundário §8.3 só é permitido depois de falha CONFIRMADA', () => {
    expect(secondaryAllowedAfter('confirmed_provider')).toBe(true);
    expect(secondaryAllowedAfter('confirmed_rate_limited')).toBe(true);
    // Timeout e conexão perdida: o resultado é desconhecido, logo repetir ou
    // trocar de modelo pode duplicar trabalho pago.
    expect(secondaryAllowedAfter('uncertain_timeout')).toBe(false);
    expect(secondaryAllowedAfter('uncertain_network')).toBe(false);
    expect(secondaryAllowedAfter(null)).toBe(false);
  });
});

describe('STK-F2-06 §15 — persistência sanitizada', () => {
  it('o registro guarda estrutura, versão, hashes e categoria — nunca prompt ou resposta', async () => {
    const inboxId = await newInbox();
    await policy.record(context, {
      inboxId,
      imageSha256: sha256Of(image),
      outcome: 'presented',
      sanitized: extraction('FFF666'),
    });
    const row = (
      await database.pool.query('select * from integration.extraction_audit where inbox_id=$1', [
        inboxId,
      ])
    ).rows[0];
    // O que existe: a estrutura sanitizada, a versão do pipeline e os hashes.
    expect(row.pipeline_version).toBe(EXTRACTION_PIPELINE_VERSION);
    expect(row.sanitized).toMatchObject({ reference: 'FFF666', currency: 'BRL' });
    expect(row.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row.response_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row.image_sha256).toBe(sha256Of(image));
    // O que NÃO existe: nenhuma coluna de prompt, resposta bruta ou conteúdo.
    expect(
      Object.keys(row).filter(
        (key) =>
          /prompt|response_raw|content|raw|text/i.test(key) &&
          !/sha256|error_category|pipeline_version|organization_id|inbox_id|outcome_presented|breaker_scope/.test(
            key,
          ),
      ),
    ).toEqual([]);
  });

  it('um payload com texto bruto é REJEITADO na borda e nada é gravado', () => {
    // A prova de que a sanitização é imposta pelo schema, não por filtro depois.
    const attempt = () =>
      extractionAuditRecordSchema.parse({
        pipelineVersion: EXTRACTION_PIPELINE_VERSION,
        outcome: 'presented',
        errorCategory: null,
        imageSha256: sha256Of(image),
        promptHash: 'a'.repeat(64),
        responseHash: 'b'.repeat(64),
        sanitized: extraction('GGG777'),
        candidates: null,
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        model: 'google/gemini-3.8-flash',
        elapsedMs: 120,
        quotaUnit: 1,
        rawResponse: '{"choices":[{"message":{"content":"Bilhete Betano 10.00"}}]}',
      });
    expect(attempt).toThrow();
  });

  it('a coluna do item acompanha o desfecho, sem depender de join', async () => {
    const inboxId = await newInbox();
    await policy.record(context, {
      inboxId,
      imageSha256: sha256Of(image),
      outcome: 'presented',
      sanitized: extraction('HHH888'),
    });
    const row = (
      await database.pool.query(
        'select extraction_pipeline_version,extraction_outcome,extraction_presented_at from integration.inbox where id=$1',
        [inboxId],
      )
    ).rows[0];
    expect(row.extraction_pipeline_version).toBe(EXTRACTION_PIPELINE_VERSION);
    expect(row.extraction_outcome).toBe('presented');
    expect(row.extraction_presented_at).not.toBeNull();
  });

  it('uma falha registra a categoria, e o banco recusa coerência impossível', async () => {
    const inboxId = await newInbox();
    await policy.recordFailure(context, {
      inboxId,
      imageSha256: sha256Of(image),
      category: 'uncertain_network',
    });
    const row = (
      await database.pool.query(
        'select extraction_outcome,extraction_error_category,extraction_presented_at from integration.inbox where id=$1',
        [inboxId],
      )
    ).rows[0];
    expect(row.extraction_outcome).toBe('uncertain');
    expect(row.extraction_error_category).toBe('uncertain_network');
    // Falha técnica não marca apresentação — logo, não consome cota.
    expect(row.extraction_presented_at).toBeNull();
  });

  it('o banco recusa um desfecho apresentado com categoria de erro', async () => {
    const inboxId = await newInbox();
    await expect(
      database.pool.query(
        `insert into integration.extraction_audit
           (organization_id,inbox_id,pipeline_version,outcome,error_category,outcome_presented,presented_at)
         values ($1,$2,$3,'presented','confirmed_provider',true,now())`,
        [context.organizationId, inboxId, EXTRACTION_PIPELINE_VERSION],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('o banco recusa presented_at sem desfecho de apresentação', async () => {
    const inboxId = await newInbox();
    await expect(
      database.pool.query(
        `insert into integration.extraction_audit
           (organization_id,inbox_id,pipeline_version,outcome,error_category,outcome_presented,presented_at)
         values ($1,$2,$3,'uncertain','uncertain_timeout',false,now())`,
        [context.organizationId, inboxId, EXTRACTION_PIPELINE_VERSION],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('STK-F2-06 §15 — a política aplicada à chamada paga', () => {
  const policyRequest = (inboxId: string) => ({
    context,
    inboxId,
    image,
    imageSha256: sha256Of(image),
    userId: null,
  });

  const usageToday = async () => {
    const row = (
      await database.pool.query(
        'select presented,uncertain,failed,refused,requests from integration.ai_usage_day where day=$1',
        [today()],
      )
    ).rows[0];
    return {
      presented: Number(row?.presented ?? 0),
      uncertain: Number(row?.uncertain ?? 0),
      failed: Number(row?.failed ?? 0),
      refused: Number(row?.refused ?? 0),
      requests: Number(row?.requests ?? 0),
    };
  };

  it('um timeout interrompe o item para ação manual, sem repetir a chamada paga', async () => {
    const inboxId = await newInbox();
    // O fetch rejeita como faria um corte de rede: a resposta é INCERTA.
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('socket hang up'));
    const result = await extractUnderPolicy(policyRequest(inboxId), {
      database,
      apiKey: API_KEY,
      fetchImpl,
    });
    expect(result.kind).toBe('uncertain');
    // A prova de que não há fallback automático: UMA chamada, e nenhuma segunda.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // E a cota intacta: falha técnica não consome unidade.
    expect(await usageToday()).toMatchObject({ presented: 0, requests: 0, uncertain: 1 });
  });

  it('uma resposta confirmada apresenta a estrutura e consome uma unidade', async () => {
    const inboxId = await newInbox();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(completion));
    const result = await extractUnderPolicy(policyRequest(inboxId), {
      database,
      apiKey: API_KEY,
      fetchImpl,
    });
    expect(result.kind).toBe('presented');
    expect(result.kind === 'presented' && result.quotaUnit).toBe(1);
    expect(result.kind === 'presented' && result.pipelineVersion).toBe(EXTRACTION_PIPELINE_VERSION);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await usageToday()).toMatchObject({ presented: 1, requests: 1 });
    // A estrutura gravada é a sanitizada: nenhum texto bruto entrou.
    const row = (
      await database.pool.query(
        'select sanitized,prompt_sha256,response_sha256 from integration.extraction_audit where inbox_id=$1',
        [inboxId],
      )
    ).rows[0];
    expect(row.sanitized).toMatchObject({ currency: 'BRL' });
    expect(row.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row.response_sha256).toMatch(/^[a-f0-9]{64}$/);
    // O hash do prompt é o do TEXTO ENVIADO, não um id de requisição: é o que
    // prova qual prompt versionado produziu a estrutura.
    expect(row.prompt_sha256).toBe(sha256Of(Buffer.from(TICKET_EXTRACTION_SYSTEM_PROMPT, 'utf8')));
  });

  it('com o teto atingido, nenhuma chamada paga é feita e o item fica para o usuário', async () => {
    const inboxId = await newInbox();
    await database.pool.query(
      `insert into integration.ai_usage_day(day,requests,presented) values($1,60,60)
       on conflict(day) do update set presented=60, requests=60`,
      [today()],
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(completion));
    const result = await extractUnderPolicy(policyRequest(inboxId), {
      database,
      apiKey: API_KEY,
      fetchImpl,
    });
    expect(result.kind).toBe('refused');
    // Zero chamadas ao fornecedor: a recusa acontece ANTES da porta de rede.
    expect(fetchImpl).not.toHaveBeenCalled();
    // O item continua disponível — a recusa é de orçamento, não de conteúdo.
    const row = (
      await database.pool.query('select state from integration.inbox where id=$1', [inboxId])
    ).rows[0];
    expect(row.state).toBe('pending');
    // E a recusa não consome cota: presented segue no teto, sem subir.
    expect(await usageToday()).toMatchObject({ presented: 60, refused: 1 });
  });
});
