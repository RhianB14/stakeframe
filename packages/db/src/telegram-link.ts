/**
 * STK-F2-04 — vínculo entre a conta Telegram e o usuário do produto.
 *
 * Plano Master §8.2: uma conta Telegram por usuário, globalmente única;
 * vinculação por deep link de uso único com expiração de cinco minutos,
 * confirmação no site, revogação e relink auditados. O transporte continua
 * sendo o polling do worker existente (nenhum webhook, nenhum serviço novo).
 *
 * Fronteiras de segurança:
 * - O token bruto do deep link NUNCA é persistido, registrado ou devolvido
 *   dentro de qualquer estado: só o SHA-256 dele vai para o banco, e a
 *   resolução é feita pelo índice único desse hash (mesma técnica de
 *   `core.beta_invitation`).
 * - `requestLink` é chamado pelo servidor autenticado e devolve o token ao
 *   chamador autorizado uma única vez, como `betaInvitation.createInvitation`.
 * - `claimTelegramAccount` é chamado pelo worker, que enxerga o deep link já
 *   materializado no Telegram: grava o ID numérico observado pelo bot, nunca um
 *   identificador escolhido pelo cliente. Ele NÃO decide vínculo algum — a
 *   confirmação é sempre no site.
 * - `confirmLink` roda em transação única: vínculo ativo, consumo do deep link e
 *   auditoria commitam juntos ou não commitam nada.
 * - `core.telegram_link` tem RLS fail-closed, então toda transação que a toca
 *   recebe o contexto de organização ANTES de qualquer leitura ou escrita.
 * - A unicidade GLOBAL da conta é decidida pelo índice parcial do BANCO, nunca
 *   por uma checagem de aplicação: a RLS esconde as linhas de outra
 *   organização, então só o índice enxerga o conflito entre organizações.
 * - Todo erro é o código sanitizado em si: nenhum SQL, tabela, host, e-mail,
 *   nome ou id de Telegram chega a log ou resposta.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ORGANIZATION_CONTEXT_SETTING } from './tenant-context.js';
import type { Database } from './index.js';

export type TelegramLinkErrorCode =
  | 'TELEGRAM_LINK_INVALID'
  | 'TELEGRAM_LINK_EXPIRED'
  | 'TELEGRAM_LINK_CONSUMED'
  | 'TELEGRAM_LINK_REVOKED'
  | 'TELEGRAM_LINK_NOT_CLAIMED'
  | 'TELEGRAM_LINK_ALREADY_LINKED'
  | 'TELEGRAM_LINK_IDENTITY_CONFLICT'
  | 'TELEGRAM_LINK_NOT_LINKED'
  | 'TELEGRAM_LINK_UNAVAILABLE';

/** Erro estável e sanitizado: a mensagem É o código, então nenhum dado privado escapa. */
export class TelegramLinkError extends Error {
  constructor(public readonly code: TelegramLinkErrorCode) {
    super(code);
    this.name = 'TelegramLinkError';
  }
}

/** Plano §8.2: o deep link de uso único expira em cinco minutos. */
export const TELEGRAM_LINK_TTL_MS = 5 * 60 * 1000;
const TOKEN_BYTES = 32;
const MAX_TOKEN_LENGTH = 512;
const MIN_TTL_MS = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_ACCOUNT_INDEX = 'telegram_link_active_telegram_id_key';
const ACTIVE_USER_INDEX = 'telegram_link_active_user_id_key';

type LinkRequestRow = {
  id: string;
  user_id: string;
  state: string;
  telegram_user_id: string | null;
  expires_at: Date | string;
};

/** SHA-256 hexadecimal do token bruto; é a única forma persistida do segredo. */
export function hashTelegramLinkToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function assertTokenShape(token: unknown): asserts token is string {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH)
    throw new TelegramLinkError('TELEGRAM_LINK_INVALID');
}

function assertUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 255)
    throw new TelegramLinkError('TELEGRAM_LINK_INVALID');
}

function assertTelegramId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value))
    throw new TelegramLinkError('TELEGRAM_LINK_INVALID');
}

function toInstant(value: Date | string): Date {
  const instant = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(instant.getTime()) ? new Date(0) : instant;
}

/** O deep link só é utilizável enquanto `pending`/`claimed` e dentro da janela de cinco minutos. */
function assertUsable(row: LinkRequestRow | undefined): LinkRequestRow {
  if (!row) throw new TelegramLinkError('TELEGRAM_LINK_INVALID');
  if (row.state === 'consumed') throw new TelegramLinkError('TELEGRAM_LINK_CONSUMED');
  if (toInstant(row.expires_at).getTime() <= Date.now())
    throw new TelegramLinkError('TELEGRAM_LINK_EXPIRED');
  if (row.state === 'revoked') throw new TelegramLinkError('TELEGRAM_LINK_REVOKED');
  if (row.state !== 'pending' && row.state !== 'claimed')
    throw new TelegramLinkError('TELEGRAM_LINK_INVALID');
  return row;
}

/**
 * O driver (e o drizzle) embrulham violações de unicidade; a cadeia de `cause` é
 * percorrida atrás dos metadados do pg. As mensagens nunca são inspecionadas —
 * elas podem carregar SQL.
 */
function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505' && candidate.constraint === constraint) return true;
    current = candidate.cause;
  }
  return false;
}

async function rollback(client: PoolClient) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // A falha original é a que vale reportar; uma conexão quebrada é apenas liberada.
  }
}

type ActiveLink = { id: string; telegram_user_id: string; linked_at: Date | string };

export function createTelegramLinkService(database: Database) {
  /**
   * Transação própria com o contexto de organização já aplicado. Toda operação
   * que toca `core.telegram_link` ou `finance.audit` (ambas com RLS) passa por
   * aqui; sem contexto a política não casa linha nenhuma e a escrita é recusada.
   */
  async function inTransaction<T>(
    organizationId: string | null,
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await database.pool.connect();
    } catch {
      throw new TelegramLinkError('TELEGRAM_LINK_UNAVAILABLE');
    }
    try {
      await client.query('BEGIN');
      if (organizationId) {
        await client.query('SELECT set_config($1, $2, true)', [
          ORGANIZATION_CONTEXT_SETTING,
          organizationId,
        ]);
      }
      let result: T;
      try {
        result = await action(client);
      } catch (error) {
        await rollback(client);
        throw error;
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollback(client);
      throw error instanceof TelegramLinkError
        ? error
        : new TelegramLinkError('TELEGRAM_LINK_UNAVAILABLE');
    } finally {
      client.release();
    }
  }

  async function readActiveLink(
    client: PoolClient,
    organizationId: string,
    userId: string,
    forUpdate = false,
  ): Promise<ActiveLink | null> {
    const rows = (
      await client.query<ActiveLink>(
        `select id,telegram_user_id,linked_at from core.telegram_link
          where organization_id = $1 and user_id = $2 and state = 'active'${
            forUpdate ? ' for update' : ''
          }`,
        [organizationId, userId],
      )
    ).rows;
    return rows[0] ?? null;
  }

  async function consume(client: PoolClient, requestId: string) {
    await client.query(
      `update core.telegram_link_request
          set state = 'consumed', consumed_at = now(), updated_at = now()
        where id = $1`,
      [requestId],
    );
  }

  /**
   * Emite um deep link de uso único para o usuário autenticado. Um pedido
   * anterior ainda vivo do MESMO usuário é invalidado antes do novo: assim há no
   * máximo um link utilizável por conta, e o antigo — que pode ter sido copiado —
   * deixa de valer imediatamente.
   *
   * O token bruto é devolvido uma única vez ao servidor autorizado; só o hash
   * vai para o banco.
   */
  async function requestLink(input: {
    userId: string;
    organizationId: string;
    ttlMs?: number;
  }): Promise<{ token: string; expiresAt: string }> {
    assertUserId(input.userId);
    if (!UUID_PATTERN.test(String(input.organizationId ?? '')))
      throw new TelegramLinkError('TELEGRAM_LINK_INVALID');
    const ttlMs = input.ttlMs ?? TELEGRAM_LINK_TTL_MS;
    // O teto é a regra do produto (cinco minutos); um TTL menor é aceito para
    // ensaios, um maior nunca.
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > TELEGRAM_LINK_TTL_MS)
      throw new TelegramLinkError('TELEGRAM_LINK_INVALID');
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const tokenHash = hashTelegramLinkToken(token);
    return inTransaction(null, async (client) => {
      // Invalida pedidos vivos do próprio usuário (nunca os de outro usuário).
      await client.query(
        `update core.telegram_link_request
            set state = 'revoked', updated_at = now()
          where user_id = $1 and state in ('pending','claimed')`,
        [input.userId],
      );
      const inserted = await client.query<{ expires_at: Date }>(
        `insert into core.telegram_link_request (user_id, token_hash, expires_at)
         values ($1, $2, now() + make_interval(secs => $3::double precision / 1000.0))
         returning expires_at`,
        [input.userId, tokenHash, ttlMs],
      );
      const row = inserted.rows[0];
      if (!row) throw new TelegramLinkError('TELEGRAM_LINK_UNAVAILABLE');
      return { token, expiresAt: toInstant(row.expires_at).toISOString() };
    });
  }

  /**
   * Confirmação no site: consome o deep link e ativa o vínculo numa transação
   * única, junto da auditoria. Regras verificadas no servidor, nunca no cliente:
   *  - o deep link precisa existir, estar dentro da janela de cinco minutos e não
   *    ter sido consumido;
   *  - ele precisa pertencer a ESTE usuário (um token copiado de outra conta não
   *    confirma o vínculo de ninguém);
   *  - a conta Telegram precisa ter sido observada no bot (`claimed`) — o
   *    navegador jamais escolhe a conta;
   *  - a conta não pode estar ativa em outro usuário (conflito de identidade,
   *    decidido pelo índice global do banco);
   *  - o consumo é único: reapresentar um link já consumido é recusado.
   *
   * Relink é o caminho esperado e auditado: um vínculo ativo anterior do MESMO
   * usuário é encerrado (nunca apagado) e o novo assume na mesma transação,
   * então trocar de celular é uma única operação e a trilha preserva qual conta
   * foi substituída. Dois vínculos ativos do mesmo usuário são impossíveis —
   * é o índice parcial do banco que garante.
   */
  async function confirmLink(input: {
    userId: string;
    organizationId: string;
    token: string;
  }): Promise<{ linkedAt: string }> {
    assertUserId(input.userId);
    assertTokenShape(input.token);
    return inTransaction(input.organizationId, async (client) => {
      const found = await client.query<LinkRequestRow>(
        `select id,user_id,state,telegram_user_id,expires_at
           from core.telegram_link_request where token_hash = $1 for update`,
        [hashTelegramLinkToken(input.token)],
      );
      const request = assertUsable(found.rows[0]);
      if (request.user_id !== input.userId) throw new TelegramLinkError('TELEGRAM_LINK_INVALID');
      if (request.state !== 'claimed' || request.telegram_user_id === null)
        throw new TelegramLinkError('TELEGRAM_LINK_NOT_CLAIMED');

      // Troca de conta (relink) é o caminho esperado e AUDITADO: o vínculo
      // ativo anterior do próprio usuário é encerrado (nunca apagado) e o novo
      // assume no mesmo instante. Sem isto, trocar de celular obrigaria a um
      // passinho extra de revogação e deixaria duas contas vivas se o usuário
      // falhasse no meio do caminho. A unicidade global do BANCO continua
      // decidindo se a conta nova pertence a outro usuário.
      const revoked = await client.query<{ id: string }>(
        `update core.telegram_link
            set state = 'revoked', revoked_at = now(), updated_at = now()
          where organization_id = $1 and user_id = $2 and state = 'active'
          returning id`,
        [input.organizationId, input.userId],
      );
      let linkedAt: Date;
      try {
        const inserted = await client.query<{ linked_at: Date }>(
          `insert into core.telegram_link (organization_id, user_id, telegram_user_id)
           values ($1, $2, $3) returning linked_at`,
          [input.organizationId, input.userId, request.telegram_user_id],
        );
        const link = inserted.rows[0];
        if (!link) throw new TelegramLinkError('TELEGRAM_LINK_UNAVAILABLE');
        linkedAt = link.linked_at;
      } catch (error) {
        if (isUniqueViolationOn(error, ACTIVE_ACCOUNT_INDEX))
          throw new TelegramLinkError('TELEGRAM_LINK_IDENTITY_CONFLICT');
        if (isUniqueViolationOn(error, ACTIVE_USER_INDEX))
          throw new TelegramLinkError('TELEGRAM_LINK_ALREADY_LINKED');
        throw error;
      }
      await consume(client, request.id);
      // Auditoria sanitizada: apenas se houve relink e o id do vínculo revogado.
      // Nunca o ID numérico do Telegram, nunca o token, nunca nome/e-mail.
      await client.query(
        `insert into finance.audit (organization_id, type, actor, entity_id, after)
         values ($1, 'telegram.link_confirmed', $2, $3,
                 jsonb_build_object('relinked', $4::boolean, 'revokedLinkId', coalesce($5::text, '')))`,
        [
          input.organizationId,
          input.userId,
          toInstant(linkedAt).toISOString(),
          (revoked.rowCount ?? 0) > 0,
          revoked.rows[0]?.id ?? null,
        ],
      );
      return { linkedAt: toInstant(linkedAt).toISOString() };
    });
  }

  /**
   * Worker: o deep link foi aberto no Telegram e a conta do remetente ficou
   * registrada. Só grava o id numérico observado pelo bot. Reuso indevido (o
   * link já foi reivindicado por outra conta) é recusado.
   */
  async function claimTelegramAccount(token: string, telegramUserId: string): Promise<boolean> {
    assertTokenShape(token);
    assertTelegramId(telegramUserId);
    return inTransaction(null, async (client) => {
      const found = await client.query<LinkRequestRow>(
        `select id,user_id,state,telegram_user_id,expires_at
           from core.telegram_link_request where token_hash = $1 for update`,
        [hashTelegramLinkToken(token)],
      );
      const request = assertUsable(found.rows[0]);
      if (request.telegram_user_id !== null && request.telegram_user_id !== telegramUserId)
        throw new TelegramLinkError('TELEGRAM_LINK_INVALID');
      const updated = await client.query(
        `update core.telegram_link_request
            set state = 'claimed', telegram_user_id = $2, claimed_at = now(), updated_at = now()
          where id = $1 and state = 'pending'`,
        [request.id, telegramUserId],
      );
      return (updated.rowCount ?? 0) > 0;
    });
  }

  /**
   * Revogação explícita pelo site. Encerrar um vínculo já revogado responde
   * `NOT_LINKED`: o estado já é o desejado e a interface precisa dizer a
   * verdade ao usuário.
   */
  async function revokeLink(input: { userId: string; organizationId: string }): Promise<void> {
    assertUserId(input.userId);
    await inTransaction(input.organizationId, async (client) => {
      const updated = await client.query<{ id: string }>(
        `update core.telegram_link
            set state = 'revoked', revoked_at = now(), updated_at = now()
          where organization_id = $1 and user_id = $2 and state = 'active'
          returning id`,
        [input.organizationId, input.userId],
      );
      const link = updated.rows[0];
      if (!link) throw new TelegramLinkError('TELEGRAM_LINK_NOT_LINKED');
      await client.query(
        `insert into finance.audit (organization_id, type, actor, entity_id, after)
         values ($1, 'telegram.link_revoked', $2, $3, '{}'::jsonb)`,
        [input.organizationId, input.userId, link.id],
      );
    });
  }

  /** Estado do próprio vínculo; nunca o de terceiros. Ausente é `unknown`, não erro. */
  async function linkStatus(input: {
    userId: string;
    organizationId: string;
  }): Promise<{ linked: boolean; linkedAt: string | null }> {
    assertUserId(input.userId);
    return inTransaction(input.organizationId, async (client) => {
      const link = await readActiveLink(client, input.organizationId, input.userId);
      return link
        ? { linked: true, linkedAt: toInstant(link.linked_at).toISOString() }
        : { linked: false, linkedAt: null };
    });
  }

  /**
   * Username público do bot, gravado pelo worker a partir de `getMe`. Só o
   * formato do Telegram é aceito: nada de URL, nada de arroba, nada que possa
   * virar link trick no site. Sem valor válido, o estado anterior é preservado.
   */
  async function recordBotUsername(username: string): Promise<void> {
    if (typeof username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(username))
      throw new TelegramLinkError('TELEGRAM_LINK_INVALID');
    await inTransaction(null, async (client) => {
      await client.query(
        `insert into core.telegram_bot (id, username) values ('default', $1)
         on conflict (id) do update set username = excluded.username, resolved_at = now()`,
        [username],
      );
    });
  }

  /** `null` quando o bot ainda não foi resolvido: o chamador falha fechado. */
  async function botUsername(): Promise<string | null> {
    const rows = (
      await database.pool.query<{ username: string }>(
        "select username from core.telegram_bot where id = 'default'",
      )
    ).rows;
    const username = rows[0]?.username;
    return username && /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : null;
  }

  return {
    requestLink,
    confirmLink,
    claimTelegramAccount,
    revokeLink,
    linkStatus,
    recordBotUsername,
    botUsername,
  };
}

export type TelegramLinkService = ReturnType<typeof createTelegramLinkService>;
