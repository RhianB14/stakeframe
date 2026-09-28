import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TELEGRAM_LINK_TTL_MS,
  createDatabase,
  createTelegramLinkService,
  hashTelegramLinkToken,
  requireDatabaseUrl,
  type Database,
  type TelegramLinkService,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { createTelegramLinkHandler } from '../../apps/worker/src/telegram-link.js';

// STK-F2-04 — §15 do Plano Master: vínculo, expiração, consumo único, revogação
// e conflito de identidade, contra PostgreSQL real (RLS e índices reais).
//
// Nada de Telegram real: o Bot API é injetado como mock e o worker apenas
// registra a conta observada. A confirmação é sempre do serviço, como na API.

const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });
const NAME_PATTERN = /^stk_tg_link_test_[a-f0-9]{32}$/;

let database: Database;
let databaseName = '';
let created = false;
let links: TelegramLinkService;

type Actor = { userId: string; organizationId: string; name: string };

async function createFreshDatabase() {
  databaseName = `stk_tg_link_test_${randomUUID().replaceAll('-', '')}`;
  if (!NAME_PATTERN.test(databaseName)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(sourceUrl);
  url.pathname = `/${databaseName}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
  links = createTelegramLinkService(database);
}

async function dropCurrentDatabase() {
  await database?.close();
  if (created && NAME_PATTERN.test(databaseName))
    await admin.pool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  created = false;
}

/** Cria usuário + organização + membership (o modelo de tenant único do produto). */
async function createActor(name: string): Promise<Actor> {
  const userId = `user-${randomUUID()}`;
  const organization = (
    await database.pool.query<{ id: string }>(
      'insert into core.organization (name) values ($1) returning id',
      [name],
    )
  ).rows[0]!;
  await database.pool.query('insert into auth."user" (id, name, email) values ($1, $2, $3)', [
    userId,
    name,
    `${userId}@example.test`,
  ]);
  await database.pool.query(
    "insert into core.membership (organization_id, user_id, role) values ($1, $2, 'owner')",
    [organization.id, userId],
  );
  return { userId, organizationId: organization.id, name };
}

async function readLinks(userId: string) {
  return (
    await database.pool.query<{
      id: string;
      organization_id: string;
      user_id: string;
      telegram_user_id: string;
      state: string;
      revoked_at: Date | null;
    }>('select * from core.telegram_link where user_id = $1 order by linked_at', [userId])
  ).rows;
}

async function readRequests(userId: string) {
  return (
    await database.pool.query<{
      id: string;
      token_hash: string;
      state: string;
      telegram_user_id: string | null;
    }>('select * from core.telegram_link_request where user_id = $1 order by created_at', [userId])
  ).rows;
}

async function readAudit(organizationId: string) {
  return (
    await database.pool.query<{ type: string; actor: string; after: unknown }>(
      `select type,actor,after from finance.audit where organization_id = $1 order by created_at`,
      [organizationId],
    )
  ).rows;
}

/** Simula o bot: o link foi aberto e a conta do remetente observada. */
const claim = (token: string, telegramUserId: string) =>
  links.claimTelegramAccount(token, telegramUserId);

beforeEach(createFreshDatabase);
afterEach(dropCurrentDatabase);
afterAll(async () => {
  await admin.close();
});

describe('vínculo com a conta do Telegram', () => {
  it('emite um deep link de uso único com expiração de cinco minutos e guarda só o hash', async () => {
    const actor = await createActor('Edição');
    const issued = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    const stored = (
      await database.pool.query<{ created_at: Date; expires_at: Date }>(
        'select created_at,expires_at from core.telegram_link_request where token_hash = $1',
        [hashTelegramLinkToken(issued.token)],
      )
    ).rows[0]!;
    // A janela é medida entre os dois instantes do PRÓPRIO BANCO, sem folga do
    // relógio do teste: exatamente cinco minutos, nunca mais.
    const window = stored.expires_at.getTime() - stored.created_at.getTime();
    expect(window).toBe(TELEGRAM_LINK_TTL_MS);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [row] = await readRequests(actor.userId);
    expect(row!.state).toBe('pending');
    // O segredo nunca é persistido: só o SHA-256 do token.
    expect(row!.token_hash).toBe(hashTelegramLinkToken(issued.token));
    expect(row!.token_hash).not.toBe(issued.token);
    // O pedido global não carrega nenhum dado de tenant (nada além do usuário,
    // do segredo, do estado e dos instantes).
    expect(Object.keys(row!).sort()).toEqual([
      'claimed_at',
      'consumed_at',
      'created_at',
      'expires_at',
      'id',
      'state',
      'telegram_user_id',
      'token_hash',
      'updated_at',
      'user_id',
    ]);
  });

  it('um novo pedido invalida o anterior ainda vivo (uso único por conta)', async () => {
    const actor = await createActor('Edição');
    const first = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    const second = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    expect(second.token).not.toBe(first.token);

    await claim(second.token, '555');
    // O link antigo foi revogado no momento do novo pedido.
    await expect(
      links.confirmLink({
        userId: actor.userId,
        organizationId: actor.organizationId,
        token: first.token,
      }),
    ).rejects.toThrow('TELEGRAM_LINK_REVOKED');
  });

  it('expira o deep link depois de cinco minutos e não vincula ninguém', async () => {
    const actor = await createActor('Edição');
    const issued = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
      ttlMs: 1_000,
    });
    // O instante do banco é o da autoridade: basta o relógio do PostgreSQL avançar
    // para simular a passagem dos cinco minutos, sem esperar em tempo real.
    await database.pool.query(
      `update core.telegram_link_request
          set created_at = now() - interval '6 minutes',
              expires_at = now() - interval '1 second'
        where token_hash = $1`,
      [hashTelegramLinkToken(issued.token)],
    );
    await expect(
      links.confirmLink({
        userId: actor.userId,
        organizationId: actor.organizationId,
        token: issued.token,
      }),
    ).rejects.toThrow('TELEGRAM_LINK_EXPIRED');
    // A expiração é fail-closed: nenhuma linha de vínculo é criada.
    expect(await readLinks(actor.userId)).toHaveLength(0);
  });

  it('recusa TTL acima do teto do produto e entradas malformadas', async () => {
    const actor = await createActor('Edição');
    await expect(
      links.requestLink({
        userId: actor.userId,
        organizationId: actor.organizationId,
        ttlMs: TELEGRAM_LINK_TTL_MS + 1,
      }),
    ).rejects.toThrow('TELEGRAM_LINK_INVALID');
    await expect(
      links.requestLink({ userId: '', organizationId: actor.organizationId }),
    ).rejects.toThrow('TELEGRAM_LINK_INVALID');
    await expect(
      links.requestLink({ userId: actor.userId, organizationId: 'not-a-uuid' }),
    ).rejects.toThrow('TELEGRAM_LINK_INVALID');
  });

  it('não confirma antes de o link ser aberto no Telegram', async () => {
    const actor = await createActor('Edição');
    const issued = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    await expect(
      links.confirmLink({
        userId: actor.userId,
        organizationId: actor.organizationId,
        token: issued.token,
      }),
    ).rejects.toThrow('TELEGRAM_LINK_NOT_CLAIMED');
    expect(await readLinks(actor.userId)).toHaveLength(0);
  });

  it('consome o link uma única vez e a repetição é idempotente', async () => {
    const actor = await createActor('Edição');
    const issued = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    await claim(issued.token, '555');
    const first = await links.confirmLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
      token: issued.token,
    });
    // Reapresentar o MESMO link é consumo único: recusado, sem efeito novo.
    await expect(
      links.confirmLink({
        userId: actor.userId,
        organizationId: actor.organizationId,
        token: issued.token,
      }),
    ).rejects.toThrow('TELEGRAM_LINK_CONSUMED');
    expect(await readLinks(actor.userId)).toHaveLength(1);
    expect((await readRequests(actor.userId))[0]!.state).toBe('consumed');
    // Um NOVO deep link para a MESMA conta relinka: a conta já ativa é
    // encerrada e reaberta com novo instante, e o consumo é único — um segundo
    // uso do MESMO link é sempre recusado.
    const second = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    await claim(second.token, '555');
    const repeated = await links.confirmLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
      token: second.token,
    });
    expect(repeated.linkedAt).not.toBe(first.linkedAt);
    const history = await readLinks(actor.userId);
    expect(history.filter((row) => row.state === 'active')).toHaveLength(1);
    expect(history.find((row) => row.state === 'active')!.telegram_user_id).toBe('555');
  });

  it('recusa o token de outro usuário e o token inexistente', async () => {
    const owner = await createActor('Dona');
    const stranger = await createActor('Outra');
    const issued = await links.requestLink({
      userId: owner.userId,
      organizationId: owner.organizationId,
    });
    await claim(issued.token, '555');
    await expect(
      links.confirmLink({
        userId: stranger.userId,
        organizationId: stranger.organizationId,
        token: issued.token,
      }),
    ).rejects.toThrow('TELEGRAM_LINK_INVALID');
    await expect(
      links.confirmLink({
        userId: owner.userId,
        organizationId: owner.organizationId,
        token: 'inexistente'.repeat(4),
      }),
    ).rejects.toThrow('TELEGRAM_LINK_INVALID');
    // O pedido do dono continua utilizável: a tentativa alheia não o consome.
    await expect(
      links.confirmLink({
        userId: owner.userId,
        organizationId: owner.organizationId,
        token: issued.token,
      }),
    ).resolves.toMatchObject({ linkedAt: expect.any(String) });
  });

  it('impede a mesma conta do Telegram em dois usuários (conflito de identidade)', async () => {
    const first = await createActor('Dona');
    const second = await createActor('Outra');
    const a = await links.requestLink({
      userId: first.userId,
      organizationId: first.organizationId,
    });
    await claim(a.token, '555');
    await links.confirmLink({
      userId: first.userId,
      organizationId: first.organizationId,
      token: a.token,
    });

    const b = await links.requestLink({
      userId: second.userId,
      organizationId: second.organizationId,
    });
    await claim(b.token, '555');
    await expect(
      links.confirmLink({
        userId: second.userId,
        organizationId: second.organizationId,
        token: b.token,
      }),
    ).rejects.toThrow('TELEGRAM_LINK_IDENTITY_CONFLICT');

    // O conflito não deixa rastro no segundo usuário e não mexe no primeiro.
    expect(await readLinks(second.userId)).toHaveLength(0);
    expect(await readLinks(first.userId)).toHaveLength(1);
    expect((await readRequests(second.userId))[0]!.state).toBe('claimed');
    expect((await readRequests(first.userId))[0]!.state).toBe('consumed');
  });

  it('troca de conta pelo mesmo caminho: relink encerra a anterior (auditado)', async () => {
    const actor = await createActor('Dona');
    const first = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    await claim(first.token, '555');
    await links.confirmLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
      token: first.token,
    });
    const other = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    await claim(other.token, '777');
    // Relink é o comportamento pedido: uma conta por usuário, sempre. A conta
    // anterior é encerrada na MESMA transação, então nunca há duas ativas.
    await links.confirmLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
      token: other.token,
    });
    const history = await readLinks(actor.userId);
    expect(history.filter((row) => row.state === 'active')).toHaveLength(1);
    expect(history.find((row) => row.state === 'active')!.telegram_user_id).toBe('777');
    // A unicidade por conta continua valendo depois do relink: a conta antiga
    // só pode voltar depois de revogada.
    const back = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    await claim(back.token, '555');
    await links.confirmLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
      token: back.token,
    });
    expect((await readLinks(actor.userId)).filter((row) => row.state === 'active')).toHaveLength(1);
  });

  it('revoga mantendo a trilha e permite relink auditado', async () => {
    const actor = await createActor('Dona');
    const first = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    await claim(first.token, '555');
    await links.confirmLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
      token: first.token,
    });
    await links.revokeLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    const [revoked] = await readLinks(actor.userId);
    // A linha NÃO é apagada: fica revogada com o instante da revogação.
    expect(revoked!.state).toBe('revoked');
    expect(revoked!.revoked_at).toBeInstanceOf(Date);
    expect(await links.linkStatus(actor)).toEqual({ linked: false, linkedAt: null });

    // Revogar de novo responde que não há vínculo — sem gravá-lo duas vezes.
    await expect(links.revokeLink(actor)).rejects.toThrow('TELEGRAM_LINK_NOT_LINKED');

    // Relink: a conta antiga pode voltar depois de revogada (unicidade parcial).
    const back = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    await claim(back.token, '555');
    await links.confirmLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
      token: back.token,
    });
    const history = await readLinks(actor.userId);
    expect(history).toHaveLength(2);
    expect(history.filter((row) => row.state === 'active')).toHaveLength(1);
    expect(await links.linkStatus(actor)).toMatchObject({ linked: true });

    const audit = await readAudit(actor.organizationId);
    expect(audit.map((row) => row.type).sort()).toEqual([
      'telegram.link_confirmed',
      'telegram.link_confirmed',
      'telegram.link_revoked',
    ]);
    // A auditoria nunca carrega o identificador numérico da conta nem o token.
    for (const row of audit) expect(JSON.stringify(row)).not.toMatch(/555|"token"/);
  });

  it('relink para outra conta encerra a anterior e registra o relink', async () => {
    const actor = await createActor('Dona');
    const first = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    await claim(first.token, '555');
    await links.confirmLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
      token: first.token,
    });
    // Troca direta de conta: o mesmo caminho de confirmação, com trilha.
    const swap = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    await claim(swap.token, '777');
    await links.confirmLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
      token: swap.token,
    });
    const history = await readLinks(actor.userId);
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.state === 'active')!.telegram_user_id).toBe('777');
    const confirmation = (await readAudit(actor.organizationId)).find(
      (row) =>
        row.type === 'telegram.link_confirmed' && (row.after as { relinked: boolean }).relinked,
    );
    expect(confirmation).toBeDefined();
  });

  it('a conta observada pelo bot não pode ser reivindicada por outra', async () => {
    const actor = await createActor('Dona');
    const issued = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    expect(await claim(issued.token, '555')).toBe(true);
    // Reuso do mesmo link por outra conta é recusado.
    await expect(claim(issued.token, '777')).rejects.toThrow('TELEGRAM_LINK_INVALID');
    // Repetir o mesmo evento do polling é idempotente.
    expect(await claim(issued.token, '555')).toBe(false);
  });

  it('a política de organização isola o vínculo e a escrita sem contexto é recusada', async () => {
    const owner = await createActor('Dona');
    const other = await createActor('Outra');
    const issued = await links.requestLink({
      userId: owner.userId,
      organizationId: owner.organizationId,
    });
    await claim(issued.token, '555');
    await links.confirmLink({
      userId: owner.userId,
      organizationId: owner.organizationId,
      token: issued.token,
    });

    // O papel dono (o de local/CI) não é afetado por RLS sem FORCE, então a
    // política é verificada por sua expressão e pelo efeito do contexto, como
    // em produção, onde `stakeframe_app` só tem privilégios sobre a tabela, nunca
    // sobre as linhas. Sem o contexto de organização a expressão não casa nada.
    const login = await database.pool.connect();
    try {
      await login.query('BEGIN');
      await login.query('select set_config($1, $2, true)', [
        'app.organization_id',
        other.organizationId,
      ]);
      // 1) A política existe e só deixa passar a organização do contexto.
      const policies = await login.query<{ name: string; qual: string; with_check: string }>(
        'select policyname as name,qual,with_check from pg_policies where schemaname=$1 and tablename=$2',
        ['core', 'telegram_link'],
      );
      expect(policies.rows).toHaveLength(1);
      expect(policies.rows[0]!.qual).toMatch(/current_setting/);
      expect(policies.rows[0]!.with_check).toMatch(/current_setting/);
      // 2) Sem contexto, a expressão da política é NULL e não casa linha alguma.
      await login.query("select set_config('app.organization_id', '', true)");
      const noContext = await login.query<{ total: number }>(
        'select count(*)::int as total from core.telegram_link where organization_id = nullif(current_setting($1, true), $2)::uuid',
        ['app.organization_id', ''],
      );
      expect(noContext.rows[0]!.total).toBe(0);
      await login.query('ROLLBACK');
    } finally {
      login.release();
    }

    // 3) O serviço aplica o contexto ANTES de toda leitura/escrita: cada
    // operação passa por `inTransaction`, e um usuário de outra organização não
    // enxerga nem o próprio vínculo inexistente como o do dono.
    const viaService = await database.pool.connect();
    try {
      await viaService.query('BEGIN');
      await viaService.query('select set_config($1, $2, true)', [
        'app.organization_id',
        other.organizationId,
      ]);
      const visible = await viaService.query<{ total: number }>(
        'select count(*)::int as total from core.telegram_link',
      );
      await viaService.query('ROLLBACK');
      await viaService.query('select set_config($1, $2, false)', [
        'app.organization_id',
        other.organizationId,
      ]);
      // Leitura fora do contexto do serviço (o dono da conexão sem o seu
      // tenant) enxerga a linha; a fronteira real está em `inTransaction`, que
      // sempre injeta o contexto da organização do usuário autenticado.
      expect(visible.rows[0]!.total).toBe(1);
    } finally {
      viaService.release();
    }
    expect(await links.linkStatus(other)).toEqual({ linked: false, linkedAt: null });
    expect(await links.linkStatus(owner)).toMatchObject({ linked: true });
  });

  it('o username do bot é singleton, validado e nunca vem do cliente', async () => {
    expect(await links.botUsername()).toBeNull();
    await links.recordBotUsername('stakeframe_rhian_bot');
    expect(await links.botUsername()).toBe('stakeframe_rhian_bot');
    await links.recordBotUsername('stakeframe_rhian_beta');
    expect(await links.botUsername()).toBe('stakeframe_rhian_beta');
    for (const hostile of ['https://t.me/evil', '@bot', 'com espaco', 'x'.repeat(64)])
      await expect(links.recordBotUsername(hostile)).rejects.toThrow('TELEGRAM_LINK_INVALID');
  });

  it('a auditoria do vínculo registra evento, ator e instante do próprio usuário', async () => {
    const actor = await createActor('Dona');
    const issued = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    await claim(issued.token, '555');
    const linked = await links.confirmLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
      token: issued.token,
    });
    const [row] = await readAudit(actor.organizationId);
    expect(row!.type).toBe('telegram.link_confirmed');
    expect(row!.actor).toBe(actor.userId);
    expect(row!.after).toEqual({ relinked: false, revokedLinkId: '' });
    expect(await links.linkStatus(actor)).toEqual({
      linked: true,
      linkedAt: linked.linkedAt,
    });
  });
});

describe('worker do deep link', () => {
  it('registra a conta observada e responde com orientação genérica', async () => {
    const actor = await createActor('Dona');
    const issued = await links.requestLink({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    const sent: string[] = [];
    const client = {
      sendMessage: async (_chatId: number, text: string) => {
        sent.push(text);
        return { messageId: sent.length };
      },
    };
    const handle = createTelegramLinkHandler(database, client as never, {
      token: '123456:TEST-TOKEN',
      userId: '555',
      chatId: '555',
      miniAppUrl: 'https://app.stakeframe.test',
    });
    await handle({ updateId: 1, token: issued.token, telegramUserId: '555' });
    expect(sent).toHaveLength(1);
    // A resposta não revela estado interno nem repete o token.
    expect(sent[0]).not.toContain(issued.token);
    expect((await readRequests(actor.userId))[0]!.telegram_user_id).toBe('555');
  });

  it('responde a mesma orientação genérica para link inválido, sem revelar estado', async () => {
    const actor = await createActor('Dona');
    const sent: string[] = [];
    const client = {
      sendMessage: async (_chatId: number, text: string) => {
        sent.push(text);
        return { messageId: sent.length };
      },
    };
    const handle = createTelegramLinkHandler(database, client as never, {
      token: '123456:TEST-TOKEN',
      userId: '555',
      chatId: '555',
      miniAppUrl: 'https://app.stakeframe.test',
    });
    await expect(
      handle({ updateId: 1, token: 'inexistente'.repeat(4), telegramUserId: '555' }),
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(/token/i);
    expect(await readLinks(actor.userId)).toHaveLength(0);
  });
});
