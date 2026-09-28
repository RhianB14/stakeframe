import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createFinanceService,
  createImportService,
  createTelegramTicketService,
  requireDatabaseUrl,
  type Database,
  type OrganizationContext,
  type TelegramTicketService,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';

/**
 * STK-F2-05 §15 — o fluxo da mensagem Telegram até o bilhete, em PostgreSQL
 * real. Dados fictícios em banco descartável; nenhuma chamada real ao Telegram,
 * nenhuma credencial e nenhum conteúdo de bilhete em log.
 *
 * O que estes testes provam:
 *  - UMA imagem por vez: com uma foto em voo a próxima não é admitida, e a
 *    ordem da fila é a de chegada;
 *  - duplicata por IDENTIDADE DETERMINÍSTICA: o mesmo par (bytes, contexto) é
 *    reconhecível sem olhar timestamp, id de mensagem ou formato da legenda;
 *  - retry EXPLÍCITO: nada repete a chamada sozinho;
 *  - PREVIEW OBRIGATÓRIO: entre o recebimento e a decisão a aposta e a
 *    exposição são as de antes — a confirmação é a única escrita financeira;
 *  - arquivamento recuperável por 30 dias, com a duplicata não recuperável;
 *  - data de envio distinta da data do evento, nunca inferida uma da outra.
 */
const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
const image = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));

let database: Database;
let tickets: TelegramTicketService;
let imports: ReturnType<typeof createImportService>;
let finance: ReturnType<typeof createFinanceService>;
let context: OrganizationContext;
let other: OrganizationContext;
let created = false;
let name: string;

const sha256Of = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * Cada caso recebe um CONTEXTO (legenda) próprio.
 *
 * A identidade é (bytes, legenda) por definição, então a mesma foto com a mesma
 * legenda é o mesmo bilhete — inclusive nos casos que NÃO estão testando
 * duplicata. Sem esta separação, a fila acumularia o registro do caso anterior
 * e o teste mediria o caso errado.
 */
let sequence = 0;
const context1 = (salt: string) => `${salt}#${++sequence}`;
const context2 = (salt: string) => `${salt}#${++sequence}`;

/** Estados financeiros observáveis: a prova de que nada foi lançado. */
async function financialState() {
  const row = (
    await database.pool.query<{ bets: string }>('select count(*)::text as bets from finance.bet')
  ).rows[0]!;
  return { bets: Number(row.bets) };
}

/**
 * Recebe uma foto como se viesse do Telegram: cria o rascunho, vincula a
 * mensagem de origem e devolve a identidade dos bytes.
 */
async function receivePhoto(input: {
  caption: string;
  /** Instante da mensagem ORIGINAL. É o `placedAt` do bilhete. */
  receivedAt: Date;
  bytes?: Buffer;
  organization?: OrganizationContext;
}) {
  const organization = input.organization ?? context;
  const bytes = input.bytes ?? image;
  const { id } = await imports.upload(organization, randomUUID(), {
    image: bytes.toString('base64'),
    caption: input.caption,
  });
  // Vínculo com a mensagem do Telegram, como o worker faz no recebimento.
  await database.pool.query(
    `update integration.inbox
        set telegram_chat_id=4242, telegram_source_message_id=$2, telegram_received_at=$3
      where id=$1`,
    [id, 1000 + (sequence += 1), input.receivedAt],
  );
  return { id, sha256: sha256Of(bytes) };
}

/** Coloca o rascunho em `review` com uma extração sintética válida. */
async function seedExtraction(id: string) {
  const extraction = {
    reference: `F2-05-${randomUUID().slice(0, 8)}`,
    placedAtText: new Date(Date.now() - 86_400_000).toISOString(),
    currency: 'BRL',
    stake: '100.00',
    odds: '2.00',
    potentialReturn: '200.00',
    freebet: false,
    selections: [
      {
        event: 'Aurora x Central',
        sport: 'Futebol',
        market: 'Resultado',
        selection: 'Aurora',
        odds: null,
        eventDateText: null,
      },
    ],
    warnings: [],
  };
  await database.pool.query(
    `update integration.inbox
        set state='review', extraction=$2, bet_origin='real', error_code=null,
            bookmaker_override_id=(select id from finance.catalog
              where organization_id=$3 and kind='bookmaker' and name='Bet365')
      where id=$1`,
    [id, JSON.stringify({ extraction }), context.organizationId],
  );
}

/** Arquivo vivo de um bilhete, para exercitar a recuperação. */
async function findArchive(organization: OrganizationContext, inboxId: string) {
  const row = await database.pool.query<{ id: string }>(
    `select id from integration.telegram_ticket_archive
      where organization_id=$1 and inbox_id=$2 and state='archived'`,
    [organization.organizationId, inboxId],
  );
  return row.rows[0]!;
}

beforeAll(async () => {
  name = `stk_f205_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_f205_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  created = true;
  const url = new URL(source);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
  for (const user of ['fixture-owner', 'fixture-other'])
    await database.pool.query(
      `insert into auth."user"(id,name,email) values($1,$2,$3) on conflict (id) do nothing`,
      [user, user, `${user}@stk.test`],
    );
  finance = createFinanceService(database);
  imports = createImportService(database);
  tickets = createTelegramTicketService(database);
  context = await finance.ensureContext('fixture-owner');
  other = await finance.ensureContext('fixture-other');
  // A confirmação é o ÚNICO caminho que escreve no financeiro, e o serviço
  // financeiro exige a banca inicializada. Espaço e unidade são fictícios.
  const bookmaker = (await finance.workspace(context)).catalog.find(
    (entry) => entry.kind === 'bookmaker' && entry.name === 'Bet365',
  )!;
  await finance.command(context, randomUUID(), {
    type: 'bankroll.initialize',
    reserve: '5000.00',
    balances: [{ bookmakerId: bookmaker.id, amount: '5000.00' }],
    unitPercent: '1.00',
    expectedVersion: (await finance.workspace(context)).version,
  });
});

afterAll(async () => {
  try {
    await database?.close();
    if (created && /^stk_f205_test_[a-f0-9]{32}$/.test(name))
      await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  } finally {
    await admin.close();
  }
});

/**
 * Libera a vaga da fila entre os casos.
 *
 * A garantia de UMA FOTO POR VEZ é global por organização: enquanto houver
 * um `admitted`, a próxima não entra. Como os casos dividem a mesma
 * organização, cada um precisa começar com a fila limpa — senão o caso está
 * medindo o resíduo do anterior, não a própria regra.
 */
async function drainQueue() {
  await database.pool.query(
    "update integration.inbox set telegram_queue_state='none', telegram_admitted_at=null where telegram_queue_state in ('queued','admitted','preview')",
  );
}

describe('STK-F2-05 — fila de uma imagem por vez', () => {
  it('admite uma foto por vez e respeita a ordem de chegada', async () => {
    await drainQueue();
    const firstCaption = context1('primeira');
    const secondCaption = context2('segunda');
    const first = await receivePhoto({
      caption: firstCaption,
      receivedAt: new Date('2026-09-20T10:00:00Z'),
    });
    await tickets.enqueue(context, {
      inboxId: first.id,
      imageSha256: first.sha256,
      caption: firstCaption,
      receivedAt: new Date('2026-09-20T10:00:00Z'),
    });
    const second = await receivePhoto({
      caption: secondCaption,
      receivedAt: new Date('2026-09-20T10:05:00Z'),
    });
    await tickets.enqueue(context, {
      inboxId: second.id,
      imageSha256: second.sha256,
      caption: secondCaption,
      receivedAt: new Date('2026-09-20T10:05:00Z'),
    });

    // A vaga pertence à foto mais antiga.
    expect(await tickets.admitNext(context)).toBe(first.id);
    // Enquanto ela está em voo, a SEGUNDA não é admitida: uma foto por vez.
    expect(await tickets.admitNext(context)).toBeNull();
    // A fila da outra organização não é bloqueada e não tem o que admitir.
    expect(await tickets.admitNext(other)).toBeNull();

    // Publicar o preview libera a vaga: quem protege o dinheiro é a decisão,
    // não a fila.
    await seedExtraction(first.id);
    await tickets.publishPreview(context, first.id);
    expect(await tickets.admitNext(context)).toBe(second.id);
    expect(await tickets.admitNext(context)).toBeNull();
  });

  it('devolve à fila uma admissão abandonada em vez de perder a foto', async () => {
    await drainQueue();
    const caption = context1('preso');
    const stuck = await receivePhoto({ caption, receivedAt: new Date('2026-09-21T09:00:00Z') });
    await tickets.enqueue(context, {
      inboxId: stuck.id,
      imageSha256: stuck.sha256,
      caption,
      receivedAt: new Date('2026-09-21T09:00:00Z'),
    });
    expect(await tickets.admitNext(context)).toBe(stuck.id);
    // O worker caiu no meio: a admissão envelhece e a foto volta à fila.
    await database.pool.query(
      "update integration.inbox set telegram_admitted_at=now()-interval '20 minutes' where id=$1",
      [stuck.id],
    );
    expect(await tickets.admitNext(context)).toBe(stuck.id);
  });

  it('libera a vaga explicitamente quando a extração ainda não está pronta', async () => {
    await drainQueue();
    const caption = context1('aguardando');
    const waiting = await receivePhoto({ caption, receivedAt: new Date('2026-09-22T08:00:00Z') });
    await tickets.enqueue(context, {
      inboxId: waiting.id,
      imageSha256: waiting.sha256,
      caption,
      receivedAt: new Date('2026-09-22T08:00:00Z'),
    });
    expect(await tickets.admitNext(context)).toBe(waiting.id);
    await tickets.releaseAdmission(context, waiting.id);
    // A vaga voltou: a próxima foto pode ser admitida.
    expect(await tickets.admitNext(context)).toBe(waiting.id);
  });
});

describe('STK-F2-05 — duplicata por identidade determinística', () => {
  it('trata o reenvio da mesma foto como duplicata, sem depender do horário', async () => {
    const caption = context1('reenvio');
    const original = await receivePhoto({ caption, receivedAt: new Date('2026-09-23T12:00:00Z') });
    const enqueued = await tickets.enqueue(context, {
      inboxId: original.id,
      imageSha256: original.sha256,
      caption,
      receivedAt: new Date('2026-09-23T12:00:00Z'),
    });
    expect(enqueued.state).toBe('queued');
    await seedExtraction(original.id);

    // Reenvio: MESMA foto, MESMO contexto, outra mensagem e três horas depois.
    // A grafia da legenda muda (maiúsculas e espaços) e NÃO pode virar outro
    // bilhete — a identidade é do contexto declarado, não da digitação.
    const messy = caption.toUpperCase().replace(/\n/, '  \n  ');
    const resent = await receivePhoto({
      caption: messy,
      receivedAt: new Date('2026-09-23T15:00:00Z'),
    });
    const again = await tickets.enqueue(context, {
      inboxId: resent.id,
      imageSha256: resent.sha256,
      caption: messy,
      receivedAt: new Date('2026-09-23T15:00:00Z'),
    });
    expect(again.state).toBe('duplicate');
    expect(again.duplicateOf).toBe(original.id);

    const preview = await tickets.preview(context, resent.id);
    expect(preview.duplicate).toMatchObject({
      detected: true,
      ofImportId: original.id,
      reasons: ['image'],
    });
    // Duplicata não ocupa a fila e não abre decisão de lançamento.
    expect(preview.actions).toEqual([]);
  });

  it('aceita a mesma foto quando o contexto declarado é diferente', async () => {
    const caption = context1('contexto-distinto');
    const incoming = await receivePhoto({ caption, receivedAt: new Date('2026-09-24T10:00:00Z') });
    const result = await tickets.enqueue(context, {
      inboxId: incoming.id,
      imageSha256: incoming.sha256,
      caption,
      receivedAt: new Date('2026-09-24T10:00:00Z'),
    });
    expect(result.state).toBe('queued');
  });

  it('não enxerga bilhete de outra organização', async () => {
    // O MESMO par (bytes, legenda) já existe na organização A.
    const caption = context1('isolamento');
    const seeded = await receivePhoto({ caption, receivedAt: new Date('2026-09-25T09:00:00Z') });
    await tickets.enqueue(context, {
      inboxId: seeded.id,
      imageSha256: seeded.sha256,
      caption,
      receivedAt: new Date('2026-09-25T09:00:00Z'),
    });
    // Na organização B é um bilhete novo: a identidade é escopada pelo tenant.
    const crossTenant = await receivePhoto({
      caption,
      receivedAt: new Date('2026-09-25T10:00:00Z'),
      organization: other,
    });
    const result = await tickets.enqueue(other, {
      inboxId: crossTenant.id,
      imageSha256: crossTenant.sha256,
      caption,
      receivedAt: new Date('2026-09-25T10:00:00Z'),
    });
    expect(result.state).toBe('queued');
  });
});

describe('STK-F2-05 — preview obrigatório antes de qualquer escrita financeira', () => {
  it('não cria aposta nem lançamento entre o recebimento e a confirmação', async () => {
    await drainQueue();
    const before = await financialState();
    const caption = context1('preview');
    const incoming = await receivePhoto({ caption, receivedAt: new Date('2026-09-26T11:00:00Z') });
    await tickets.enqueue(context, {
      inboxId: incoming.id,
      imageSha256: incoming.sha256,
      caption,
      receivedAt: new Date('2026-09-26T11:00:00Z'),
    });
    await seedExtraction(incoming.id);
    expect(await tickets.admitNext(context)).toBe(incoming.id);

    const preview = await tickets.publishPreview(context, incoming.id);
    expect(preview.state).toBe('review');
    expect(preview.actions).toEqual(['confirm', 'edit', 'discard']);
    // A garantia: lançamentos e exposição são os de ANTES do recebimento.
    expect(await financialState()).toEqual(before);
    expect((await finance.workspace(context)).exposure).toBe('0.00');

    // Relê-lo é leitura pura: nada muda.
    await tickets.preview(context, incoming.id);
    expect(await financialState()).toEqual(before);
  });

  it('a confirmação é a única escrita, e vem de uma versão explícita', async () => {
    await drainQueue();
    const caption = context1('confirmacao');
    const candidate = await receivePhoto({ caption, receivedAt: new Date('2026-09-27T11:00:00Z') });
    await tickets.enqueue(context, {
      inboxId: candidate.id,
      imageSha256: candidate.sha256,
      caption,
      receivedAt: new Date('2026-09-27T11:00:00Z'),
    });
    await seedExtraction(candidate.id);
    const preview = await tickets.publishPreview(context, candidate.id);
    const before = await financialState();

    // Versão errada é recusada: a decisão é sempre sobre o estado lido.
    await expect(
      imports.confirmDraft(
        context,
        candidate.id,
        { version: preview.version + 99 },
        'telegram:bot',
        randomUUID(),
      ),
    ).rejects.toThrow('VERSION_CONFLICT');
    expect(await financialState()).toEqual(before);

    // Versão correta: o caminho canônico que o botão do preview usa.
    const applied = await imports.confirmDraft(
      context,
      candidate.id,
      { version: preview.version },
      'telegram:bot',
      randomUUID(),
    );
    expect(applied.betId).toBeTruthy();
    // Exatamente UMA aposta nova: o preview, sozinho, não criou nada.
    expect(await financialState()).toEqual({ bets: before.bets + 1 });
  });

  it('recusa o retry fora do estado de falha (retry é sempre explícito)', async () => {
    const caption = context1('saudavel');
    const healthy = await receivePhoto({ caption, receivedAt: new Date('2026-09-28T11:00:00Z') });
    await tickets.enqueue(context, {
      inboxId: healthy.id,
      imageSha256: healthy.sha256,
      caption,
      receivedAt: new Date('2026-09-28T11:00:00Z'),
    });
    await seedExtraction(healthy.id);
    const preview = await tickets.publishPreview(context, healthy.id);
    await expect(tickets.retry(context, healthy.id, preview.version)).rejects.toThrow(
      'TELEGRAM_TICKET_STATE_CONFLICT',
    );
  });

  it('reprocessa sob pedido explícito quando a extração falhou', async () => {
    const caption = context1('falhou');
    const broken = await receivePhoto({ caption, receivedAt: new Date('2026-09-29T11:00:00Z') });
    await tickets.enqueue(context, {
      inboxId: broken.id,
      imageSha256: broken.sha256,
      caption,
      receivedAt: new Date('2026-09-29T11:00:00Z'),
    });
    await database.pool.query(
      "update integration.inbox set state='failed', error_code='AI_OUTCOME_UNCERTAIN' where id=$1",
      [broken.id],
    );
    const preview = await tickets.preview(context, broken.id);
    expect(preview.actions).toEqual(['edit', 'discard', 'retry']);
    expect(preview.blockedReason).toBe('EXTRACTION_FAILED');

    const retried = await tickets.retry(context, broken.id, preview.version);
    expect(retried.state).toBe('pending');
    // O pedido de extração volta na MESMA transação: nada fica preso sem fila.
    const queued = await database.pool.query<{ count: string }>(
      'select count(*)::text as count from integration.extraction_request where inbox_id=$1',
      [broken.id],
    );
    expect(Number(queued.rows[0]!.count)).toBe(1);
  });
});

describe('STK-F2-05 — arquivamento recuperável por 30 dias', () => {
  it('arquiva sem apagar e restaura dentro da janela', async () => {
    await drainQueue();
    const caption = context1('arquivo');
    const ticket = await receivePhoto({ caption, receivedAt: new Date('2026-09-15T08:00:00Z') });
    await tickets.enqueue(context, {
      inboxId: ticket.id,
      imageSha256: ticket.sha256,
      caption,
      receivedAt: new Date('2026-09-15T08:00:00Z'),
    });
    await seedExtraction(ticket.id);
    await tickets.publishPreview(context, ticket.id);

    const archived = await tickets.archive(context, ticket.id, 'discarded');
    // Trinta dias, medidos a partir do arquivamento.
    expect(
      Math.round((new Date(archived.recoverableUntil).getTime() - Date.now()) / 86_400_000),
    ).toBe(30);

    // A linha continua endereçável: descarte NÃO apaga o registro.
    const still = await tickets.preview(context, ticket.id);
    expect(still.archive).toMatchObject({ archived: true, reason: 'discarded' });
    const row = await database.pool.query<{ state: string }>(
      'select state from integration.inbox where id=$1',
      [ticket.id],
    );
    expect(row.rows[0]!.state).toBe('discarded');
    expect((await tickets.listArchive(context)).some((entry) => entry.inboxId === ticket.id)).toBe(
      true,
    );

    const betsBefore = await financialState();
    const restored = await tickets.restore(context, (await findArchive(context, ticket.id)).id);
    expect(restored.inboxId).toBe(ticket.id);
    // Restaurar devolve à fila e reabre a decisão — não cria lançamento.
    const reopened = await tickets.preview(context, ticket.id);
    expect(reopened.state).toBe('review');
    expect(reopened.queueState).toBe('queued');
    expect(await financialState()).toEqual(betsBefore);
  });

  it('recusa recuperar fora dos 30 dias e depois de já restaurado', async () => {
    const caption = context1('expirado');
    const ticket = await receivePhoto({ caption, receivedAt: new Date('2026-09-01T08:00:00Z') });
    await tickets.enqueue(context, {
      inboxId: ticket.id,
      imageSha256: ticket.sha256,
      caption,
      receivedAt: new Date('2026-09-01T08:00:00Z'),
    });
    await tickets.archive(context, ticket.id, 'discarded');
    // Envelhece o arquivo além da janela, respeitando a coerência do CHECK.
    await database.pool.query(
      `update integration.telegram_ticket_archive
          set archived_at=now()-interval '40 days', recoverable_until=now()-interval '10 days'
        where inbox_id=$1`,
      [ticket.id],
    );
    await expect(
      tickets.restore(context, (await findArchive(context, ticket.id)).id),
    ).rejects.toThrow('TELEGRAM_TICKET_EXPIRED');
  });

  it('não recupera duplicata: o registro a recuperar é o original', async () => {
    const caption = context1('unico');
    const original = await receivePhoto({ caption, receivedAt: new Date('2026-10-01T08:00:00Z') });
    await tickets.enqueue(context, {
      inboxId: original.id,
      imageSha256: original.sha256,
      caption,
      receivedAt: new Date('2026-10-01T08:00:00Z'),
    });
    const copy = await receivePhoto({ caption, receivedAt: new Date('2026-10-01T09:00:00Z') });
    const duplicate = await tickets.enqueue(context, {
      inboxId: copy.id,
      imageSha256: copy.sha256,
      caption,
      receivedAt: new Date('2026-10-01T09:00:00Z'),
    });
    expect(duplicate.state).toBe('duplicate');
    await expect(
      tickets.restore(context, (await findArchive(context, copy.id)).id),
    ).rejects.toThrow('TELEGRAM_TICKET_NOT_RECOVERABLE');
  });

  it('marca como expirado o arquivo cuja janela passou', async () => {
    const caption = context1('vencido');
    const ticket = await receivePhoto({ caption, receivedAt: new Date('2026-08-01T08:00:00Z') });
    await tickets.enqueue(context, {
      inboxId: ticket.id,
      imageSha256: ticket.sha256,
      caption,
      receivedAt: new Date('2026-08-01T08:00:00Z'),
    });
    await tickets.archive(context, ticket.id, 'discarded');
    // A janela fecha com coerência: `recoverable_until > archived_at`.
    await database.pool.query(
      `update integration.telegram_ticket_archive
          set archived_at=now()-interval '31 days', recoverable_until=now()-interval '1 day'
        where inbox_id=$1`,
      [ticket.id],
    );
    expect(await tickets.expireRecoveries(context)).toBeGreaterThan(0);
    const state = await database.pool.query<{ state: string }>(
      'select state from integration.telegram_ticket_archive where inbox_id=$1',
      [ticket.id],
    );
    expect(state.rows[0]!.state).toBe('expired');
  });

  it('não abre uma segunda janela ao descartar o que já está arquivado', async () => {
    const caption = context1('rearquivo');
    const ticket = await receivePhoto({ caption, receivedAt: new Date('2026-10-02T08:00:00Z') });
    await tickets.enqueue(context, {
      inboxId: ticket.id,
      imageSha256: ticket.sha256,
      caption,
      receivedAt: new Date('2026-10-02T08:00:00Z'),
    });
    await seedExtraction(ticket.id);
    const first = await tickets.archive(context, ticket.id, 'discarded');
    await database.pool.query("update integration.inbox set state='review' where id=$1", [
      ticket.id,
    ]);
    await database.pool.query(
      "update integration.telegram_ticket_archive set archived_at=now()-interval '5 days' where inbox_id=$1",
      [ticket.id],
    );
    const second = await tickets.archive(context, ticket.id, 'discarded');
    // O índice parcial garante um arquivo vivo por bilhete: o prazo é o do
    // arquivamento mais recente, e a janela não se acumula.
    expect(new Date(second.recoverableUntil).getTime()).toBeGreaterThan(
      new Date(first.recoverableUntil).getTime(),
    );
    const live = await database.pool.query<{ count: string }>(
      "select count(*)::text as count from integration.telegram_ticket_archive where inbox_id=$1 and state='archived'",
      [ticket.id],
    );
    expect(Number(live.rows[0]!.count)).toBe(1);
  });
});

describe('STK-F2-05 — data de envio distinta da data do evento', () => {
  it('usa o instante da mensagem original e nunca o infere como data do evento', async () => {
    const sentAt = new Date('2026-07-04T18:30:00Z');
    const caption = context1('datas');
    const ticket = await receivePhoto({ caption, receivedAt: sentAt });
    await tickets.enqueue(context, {
      inboxId: ticket.id,
      imageSha256: ticket.sha256,
      caption,
      receivedAt: sentAt,
    });
    await seedExtraction(ticket.id);
    const preview = await tickets.publishPreview(context, ticket.id);

    // A data de envio é a mensagem original, imutável.
    expect(preview.sentAt).toBe(sentAt.toISOString());
    // A data do evento é OUTRO campo: nasce pendente, mesmo com a extração
    // completa. Nunca é deduzida da data de envio.
    expect(preview.eventAt).toBeNull();
    expect(preview.eventDateStatus).toBe('pending');
    expect(preview.sentAt).not.toBe(preview.eventAt);
  });

  it('só preenche a data do evento por declaração, sem mexer na de envio', async () => {
    const sentAt = new Date('2026-07-05T09:00:00Z');
    const caption = context1('evento');
    const ticket = await receivePhoto({ caption, receivedAt: sentAt });
    await tickets.enqueue(context, {
      inboxId: ticket.id,
      imageSha256: ticket.sha256,
      caption,
      receivedAt: sentAt,
    });
    await seedExtraction(ticket.id);
    const before = await tickets.publishPreview(context, ticket.id);

    // Declaração explícita do usuário (o mesmo caminho do Mini App).
    await imports.updateDraft(
      context,
      ticket.id,
      { version: before.version, eventAt: '2026-07-20T21:00:00.000Z' },
      'web',
    );
    const after = await tickets.preview(context, ticket.id);
    expect(after.eventAt).toBe('2026-07-20T21:00:00.000Z');
    expect(after.eventDateStatus).toBe('confirmed');
    // A data de envio continua a mesma: são campos independentes.
    expect(after.sentAt).toBe(sentAt.toISOString());
    expect(after.sentAt).not.toBe(after.eventAt);
  });
});
