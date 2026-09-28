import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  classifyTicketKind,
  normalizeEventLabel,
  parseCaption,
  potentialReturnFor,
  ticketExtractionSchema,
  telegramTicketPreviewSchema,
  type BetOrigin,
  type TelegramPreviewDuplicate,
  type TelegramTicketPreview,
} from '@stakeframe/shared';
import type { Database } from './index.js';
import { createTenantContext, type OrganizationContext } from './tenant-context.js';

/**
 * STK-F2-05 — o caminho da foto até o bilhete, com o preview como fronteira
 * financeira.
 *
 * O contrato inteiro cabe em três garantias:
 *
 * 1) FILA DE UMA FOTO POR VEZ. `integration.inbox.telegram_queue_state` vai
 *    `queued -> admitted -> preview`, e o worker só admite a próxima foto quando
 *    a anterior deixou de estar `admitted`. Um `pg_advisory_xact_lock`
 *    dedicado serializa a admissão entre instâncias, e a ordem é
 *    `telegram_queued_at, id`: a foto mais antiga sempre vai primeiro e uma
 *    posterior nunca pula uma anterior.
 *
 * 2) PREVIEW OBRIGATORIO. Nenhuma escrita em `finance.bet`, `finance.journal`
 *    ou `finance.posting` acontece neste modulo: o servico so LE o rascunho e
 *    publica o preview. A aposta nasce exclusivamente por `import.confirm`
 *    (Mini App ou a decisao explicita sobre este preview), com versao otimista e
 *    chave idempotente. Enquanto o preview existir, a exposicao da organizacao e
 *    a de antes do recebimento.
 *
 * 3) DUPLICATA DETERMINISTICA. A identidade e
 *    `SHA-256(sha256_da_imagem || contexto_normalizado)`: os bytes da imagem e o
 *    contexto (os atributos declarados na legenda) entram na identidade; o id
 *    da mensagem, o `update_id` e o instante NAO entram. Assim a MESMA foto
 *    reenviada em outra mensagem, em outro minuto, e reconhecida como duplicata
 *    — a regra nao depende de timestamp, que e o que o card proibe.
 *
 * Datas: `sentAt` e `telegram_received_at`, o instante da MENSAGEM ORIGINAL
 * (imutavel, gravado no recebimento). `eventAt` e a data do EVENTO e nasce
 * `null` com `eventDateStatus = 'pending'`: ela nunca e inferida de `sentAt`.
 *
 * Privacidade: este modulo NUNCA registra conteudo de bilhete, legenda,
 * extracao ou nome. A unica coisa que chega ao log e um codigo sanitizado; a
 * auditoria em `finance.audit` grava estados e motivos, nunca valores.
 */

/** Janela de recuperacao do arquivo: 30 dias (card; sem `/undo` temporizado). */
export const TELEGRAM_ARCHIVE_RECOVERY_DAYS = 30;
const RECOVERY_MS = TELEGRAM_ARCHIVE_RECOVERY_DAYS * 24 * 60 * 60 * 1000;
/**
 * Lock de admissao da fila. Nao colide com os locks do financeiro (782341091
 * migrador, 782341092 capacidade/retencao, 782341093 cobranca de extracao,
 * 782341095 anexo): a ordem dos escritores financeiros e settings -> inbox ->
 * attachment, e esta e a regra do fluxo da fila.
 */
const QUEUE_ADMISSION_LOCK = 782341096;
/** Fila travada alem disto = admissao interrompida (worker caiu no meio). */
const ADMISSION_TIMEOUT = '15 minutes';
const ORGANIZATION_SETTING = 'app.organization_id';

export type TelegramTicketErrorCode =
  | 'TELEGRAM_TICKET_NOT_FOUND'
  | 'TELEGRAM_TICKET_STATE_CONFLICT'
  | 'TELEGRAM_TICKET_DUPLICATE'
  | 'TELEGRAM_TICKET_ARCHIVED'
  | 'TELEGRAM_TICKET_EXPIRED'
  | 'TELEGRAM_TICKET_NOT_RECOVERABLE'
  | 'TELEGRAM_TICKET_BUSY';

/** Erro estavel e sanitizado: a mensagem E o codigo, entao nada privado escapa. */
export class TelegramTicketError extends Error {
  constructor(public readonly code: TelegramTicketErrorCode) {
    super(code);
    this.name = 'TelegramTicketError';
  }
}

/**
 * Identidade deterministica do bilhete: bytes da imagem + contexto normalizado.
 *
 * O separador NUL entre os campos impede que pares distintos colidam, e a
 * normalizacao (NFD sem diacriticos, espacos colapsados, minusculas) faz a
 * identidade ignorar a forma da legenda — o que interessa e o contexto
 * declarado, nao a digitacao. O id da mensagem e o instante ficam de fora de
 * proposito: eles sao justamente o que muda entre um reenvio e o original.
 */
export function telegramTicketIdentity(imageSha256: string, context: string): string {
  if (!/^[a-f0-9]{64}$/.test(imageSha256))
    throw new TelegramTicketError('TELEGRAM_TICKET_DUPLICATE');
  const normalized = context
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ');
  const separator = '\u0000';
  return createHash('sha256').update(`${imageSha256}${separator}${normalized}`).digest('hex');
}

/**
 * Contexto normalizado que entra na identidade: a legenda inteira, reduzida à
 * sua forma mínima (NFD sem diacríticos, espaços colapsados, minúsculas).
 *
 * A legenda INTEIRA — e não os campos já posicionais — é o contexto certo: o
 * que interessa para a identidade é o que o usuário declarou junto da foto, e
 * duas grafias do mesmo aviso são o mesmo bilhete. Uma legenda realmente
 * diferente (outro tipster, outra casa) produz outra identidade, que é
 * exatamente o que se quer.
 */
export function telegramTicketContext(caption: string): string {
  return caption
    .replace(/\r\n?/g, '\n')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line.length > 0)
    .join('|');
}

const toInstant = (value: Date | string | null | undefined): Date | null => {
  if (value === null || value === undefined) return null;
  const instant = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(instant.getTime()) ? null : instant;
};
const toIso = (value: Date | string | null | undefined): string | null =>
  toInstant(value)?.toISOString() ?? null;

type Row = {
  id: string;
  state: string;
  version: number;
  caption: string;
  extraction: unknown;
  bet_origin: string | null;
  event_at: Date | null;
  event_date_status: string;
  telegram_received_at: Date | null;
  telegram_identity: string | null;
  telegram_duplicate_of: string | null;
  telegram_queue_state: string;
  telegram_preview_at: Date | null;
  metadata: unknown;
  bookmaker: string | null;
  tipster: string | null;
  archive_state: string | null;
  archive_reason: string | null;
  archive_recoverable_until: Date | null;
  archive_restored_at: Date | null;
};

const readRowSql = `select i.id,i.state,i.version,i.caption,i.extraction,i.bet_origin,i.event_at,i.event_date_status,
       i.telegram_received_at,i.telegram_identity,i.telegram_duplicate_of,i.telegram_queue_state,i.telegram_preview_at,
       i.metadata,
       (select name from finance.catalog c where c.id=i.bookmaker_override_id and c.organization_id=i.organization_id) as bookmaker,
       (select name from finance.catalog t where t.organization_id=i.organization_id and t.kind='tipster' and t.active
          and t.id::text=(i.metadata->'userOverrides'->>'tipsterId')) as tipster,
       a.state as archive_state,a.reason as archive_reason,a.recoverable_until as archive_recoverable_until,
       a.restored_at as archive_restored_at
  from integration.inbox i
  left join integration.telegram_ticket_archive a
    on a.inbox_id=i.id and a.organization_id=i.organization_id and a.state='archived'
 where i.organization_id=current_setting($1, true)::uuid and i.id=$2`;

type PreviewOverrides = {
  stake: string | null;
  odds: string | null;
  sport: string | null;
  selections: { event: string | null; market: string | null; selection: string | null }[];
};

const readOverrides = (value: unknown): PreviewOverrides => {
  const empty: PreviewOverrides = { stake: null, odds: null, sport: null, selections: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const raw = (value as { userOverrides?: unknown }).userOverrides;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const source = raw as Record<string, unknown>;
  const money = (input: unknown) =>
    typeof input === 'string' && /^\d{1,12}(\.\d{1,4})?$/.test(input) ? input : null;
  const text = (input: unknown) => (typeof input === 'string' && input.trim() ? input : null);
  const selections = Array.isArray(source.selections)
    ? source.selections
        .filter(
          (
            item,
          ): item is { event: string | null; market: string | null; selection: string | null } =>
            !!item &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            ['event', 'market', 'selection'].every(
              (key) =>
                (item as Record<string, unknown>)[key] === null ||
                typeof (item as Record<string, unknown>)[key] === 'string',
            ),
        )
        .map((item) => ({
          event: item.event ? normalizeEventLabel(item.event) : null,
          market: item.market ?? null,
          selection: item.selection ?? null,
        }))
    : [];
  return {
    stake: money(source.stake),
    odds: money(source.odds),
    sport: text(source.sport),
    selections,
  };
};

/**
 * Grava (ou atualiza) o arquivo vivo do bilhete. Sempre dentro da transacao do
 * chamador: o arquivamento e a mudanca de estado commitam juntos.
 *
 * O `ON CONFLICT` do indice parcial `telegram_ticket_archive_live_idx` e o que
 * garante "no maximo um arquivo vivo por bilhete" no BANCO — duas decisoes
 * concorrentes nao produzem dois arquivos, e o prazo de recuperacao e sempre o do
 * arquivamento mais recente.
 */
async function archiveWithin(
  client: PoolClient,
  inboxId: string,
  identity: string,
  reason: 'discarded' | 'duplicate' | 'superseded',
  now: Date,
): Promise<{ recoverableUntil: string }> {
  const recoverableUntil = new Date(now.getTime() + RECOVERY_MS);
  await client.query(
    `insert into integration.telegram_ticket_archive
       (organization_id,inbox_id,identity,reason,archived_at,recoverable_until)
     values (current_setting($1, true)::uuid,$2,$3,$4,$5,$6)
     on conflict (organization_id,inbox_id) where state='archived'
     do update set identity=excluded.identity, reason=excluded.reason,
                     archived_at=excluded.archived_at,
                     recoverable_until=excluded.recoverable_until, updated_at=now()`,
    [ORGANIZATION_SETTING, inboxId, identity, reason, now, recoverableUntil],
  );
  await client.query(
    `update integration.inbox
        set state='discarded',
            telegram_queue_state=case when telegram_queue_state='duplicate' then 'duplicate'
                                     else 'archived' end,
            updated_at=now()
      where organization_id=current_setting($1, true)::uuid and id=$2`,
    [ORGANIZATION_SETTING, inboxId],
  );
  await audit(client, 'telegram.ticket_archived', inboxId, {
    reason,
    recoveryDays: TELEGRAM_ARCHIVE_RECOVERY_DAYS,
  });
  return { recoverableUntil: recoverableUntil.toISOString() };
}

/** Auditoria estritamente sanitizada: estados e motivos, nunca conteudo. */
async function audit(
  client: PoolClient,
  type: string,
  entityId: string,
  after: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into finance.audit(organization_id,type,actor,entity_id,after)
     values (current_setting($1, true)::uuid,$2,'system:telegram',$3,$4)`,
    [ORGANIZATION_SETTING, type, entityId, JSON.stringify(after)],
  );
}

export function createTelegramTicketService(database: Database) {
  const tenant = createTenantContext(database);
  const withOrg = <T>(
    context: OrganizationContext,
    action: (client: PoolClient) => Promise<T>,
    options: { isolation?: 'repeatable read' } = {},
  ) => tenant.withOrganizationTransaction(context, action, options);

  /**
   * Recebe a foto NA FILA, sem admitir nem extrair.
   *
   * A identidade e calculada aqui, no recebimento, porque depende dos bytes ja
   * validados e do contexto — e vale para os dois caminhos (Telegram e web),
   * entao uma foto reenviada pela web tambem e reconhecida.
   *
   * A deteccao de duplicata e resolvida pelo BANCO (indice por organizacao +
   * identidade), com um advisory lock por identidade para que duas mensagens
   * chegando no mesmo instante nao se vejam como ausentes. Uma duplicata nao
   * ocupa vaga na fila: ela aponta para o original e e arquivada na hora.
   */
  async function enqueue(
    context: OrganizationContext,
    input: {
      inboxId: string;
      imageSha256: string;
      caption: string;
      /** Instante da mensagem original (UTC). E o `placedAt` do bilhete. */
      receivedAt: Date;
    },
  ): Promise<{ state: 'queued' | 'duplicate'; inboxId: string; duplicateOf: string | null }> {
    if (!Number.isFinite(input.receivedAt.getTime()))
      throw new TelegramTicketError('TELEGRAM_TICKET_STATE_CONFLICT');
    const identity = telegramTicketIdentity(
      input.imageSha256,
      telegramTicketContext(input.caption),
    );
    return withOrg(context, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `telegram-ticket-identity:${identity}`,
      ]);
      const original = (
        await client.query<{ id: string }>(
          `select id from integration.inbox
            where organization_id=current_setting($1, true)::uuid and telegram_identity=$2
              and state not in ('discarded')
            order by created_at asc, id asc limit 1`,
          [ORGANIZATION_SETTING, identity],
        )
      ).rows[0];
      if (original) {
        // Duplicata por identidade DETERMINISTICA: aponta para o original, e
        // arquivada e nao toca em nada financeiro. `state='discarded'` tira a
        // duplicata das listas pendentes; o registro original segue inteiro.
        await client.query(
          `update integration.inbox
              set telegram_duplicate_of=$3, telegram_queue_state='duplicate', state='discarded',
                  telegram_queued_at=now(), version=version+1, updated_at=now()
            where organization_id=current_setting($1, true)::uuid and id=$2`,
          [ORGANIZATION_SETTING, input.inboxId, original.id],
        );
        await archiveWithin(client, input.inboxId, identity, 'duplicate', input.receivedAt);
        return { state: 'duplicate' as const, inboxId: input.inboxId, duplicateOf: original.id };
      }
      await client.query(
        `update integration.inbox
            set telegram_identity=$3, telegram_queue_state='queued', telegram_queued_at=now(),
                telegram_received_at=$4, version=version+1, updated_at=now()
          where organization_id=current_setting($1, true)::uuid and id=$2`,
        [ORGANIZATION_SETTING, input.inboxId, identity, input.receivedAt],
      );
      return { state: 'queued' as const, inboxId: input.inboxId, duplicateOf: null };
    });
  }

  /**
   * Admissao de UMA foto por vez.
   *
   * So admite quando nao existe nenhum `admitted` vivo na organizacao. Uma
   * admissao abandonada (worker caiu no meio) volta para a fila depois de
   * `ADMISSION_TIMEOUT`, para que uma foto presa nao vire um bilhete perdido.
   */
  async function admitNext(context: OrganizationContext): Promise<string | null> {
    return withOrg(context, async (client) => {
      await client.query('select pg_advisory_xact_lock($1)', [QUEUE_ADMISSION_LOCK]);
      await client.query(
        `update integration.inbox set telegram_queue_state='queued', telegram_admitted_at=null
          where organization_id=current_setting($1, true)::uuid and telegram_queue_state='admitted'
            and (telegram_admitted_at is null or telegram_admitted_at < now()-$2::interval)`,
        [ORGANIZATION_SETTING, ADMISSION_TIMEOUT],
      );
      const busy = await client.query<{ id: string }>(
        `select id from integration.inbox
          where organization_id=current_setting($1, true)::uuid and telegram_queue_state='admitted'
          limit 1`,
        [ORGANIZATION_SETTING],
      );
      if (busy.rows[0]) return null;
      // PostgreSQL não aceita ORDER BY em UPDATE: a ordem da fila vem do
      // SELECT ... FOR UPDATE SKIP LOCKED, e só o registro travado é admitido.
      // A foto mais antiga sempre vai primeiro, e uma posterior nunca pula uma
      // anterior.
      const next = (
        await client.query<{ id: string }>(
          `select id from integration.inbox
            where organization_id=current_setting($1, true)::uuid and telegram_queue_state='queued'
            order by telegram_queued_at asc, id asc
            limit 1
            for update skip locked`,
          [ORGANIZATION_SETTING],
        )
      ).rows[0];
      if (!next) return null;
      const admitted = await client.query<{ id: string }>(
        `update integration.inbox
            set telegram_queue_state='admitted', telegram_admitted_at=now(),
                version=version+1, updated_at=now()
          where organization_id=current_setting($1, true)::uuid and id=$2
          returning id`,
        [ORGANIZATION_SETTING, next.id],
      );
      return admitted.rows[0]?.id ?? null;
    });
  }

  /**
   * Publica o preview estruturado e LIBERA a vaga da fila.
   *
   * Nenhuma escrita financeira acontece aqui — a unica mutacao e o estado da
   * fila e o carimbo do preview. A vaga e liberada aqui, nao na decisao: a
   * proxima foto pode entrar enquanto o usuario confere a anterior, e quem
   * protege o dinheiro e a DECISAO, nao a fila.
   */
  async function publishPreview(
    context: OrganizationContext,
    inboxId: string,
  ): Promise<TelegramTicketPreview> {
    return withOrg(context, async (client) => {
      const preview = await buildPreview(client, inboxId);
      await client.query(
        `update integration.inbox
            set telegram_preview_at=coalesce(telegram_preview_at, now()),
                telegram_queue_state=case when telegram_queue_state in ('admitted','queued')
                                         then 'preview' else telegram_queue_state end,
                updated_at=now()
          where organization_id=current_setting($1, true)::uuid and id=$2`,
        [ORGANIZATION_SETTING, inboxId],
      );
      return preview;
    });
  }

  /**
   * Devolve a vaga sem publicar preview. Usado quando a extracao nao esta
   * disponivel: o retry e EXPLICITO (nenhum temporizador repete chamada paga).
   */
  async function releaseAdmission(context: OrganizationContext, inboxId: string): Promise<void> {
    await withOrg(context, async (client) => {
      await client.query(
        `update integration.inbox
            set telegram_queue_state=case when telegram_queue_state='admitted' then 'queued'
                                         else telegram_queue_state end,
                telegram_admitted_at=null, updated_at=now()
          where organization_id=current_setting($1, true)::uuid and id=$2
            and telegram_queue_state='admitted'`,
        [ORGANIZATION_SETTING, inboxId],
      );
    });
  }

  /** Leitura do preview: a superficie da decisao, sem efeito colateral. */
  async function preview(
    context: OrganizationContext,
    inboxId: string,
  ): Promise<TelegramTicketPreview> {
    return withOrg(context, (client) => buildPreview(client, inboxId), {
      isolation: 'repeatable read',
    });
  }

  /**
   * Arquivamento recuperavel: 30 dias, sem apagar nada.
   *
   * Rearquivar o mesmo bilhete ATUALIZA a linha viva em vez de criar outra, e a
   * identidade vem do proprio rascunho — nunca de um valor inventado.
   */
  async function archive(
    context: OrganizationContext,
    inboxId: string,
    reason: 'discarded' | 'duplicate' | 'superseded',
  ): Promise<{ recoverableUntil: string }> {
    return withOrg(context, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `telegram-ticket-archive:${inboxId}`,
      ]);
      const row = (
        await client.query<{ telegram_identity: string | null; sha256: string; caption: string }>(
          'select telegram_identity,sha256,caption from integration.inbox where organization_id=current_setting($1, true)::uuid and id=$2 for update',
          [ORGANIZATION_SETTING, inboxId],
        )
      ).rows[0];
      if (!row) throw new TelegramTicketError('TELEGRAM_TICKET_NOT_FOUND');
      // Recalcula a partir dos bytes se o bilhete entrou por um caminho que ainda
      // nao gravou a identidade: a regra e a mesma do recebimento.
      const identity =
        row.telegram_identity ??
        telegramTicketIdentity(row.sha256, telegramTicketContext(row.caption));
      return archiveWithin(client, inboxId, identity, reason, new Date());
    });
  }

  /**
   * Recuperacao dentro dos 30 dias. Devolve a fila, nao um lancamento: quem
   * restaura volta a ver o preview e decide de novo. Fora da janela a resposta e
   * `EXPIRED`; um arquivo ja restaurado e `NOT_RECOVERABLE`.
   *
   * Uma duplicata arquivada NAO e recuperavel: o registro a recuperar e sempre o
   * original, que a duplicata aponta. Duas apostas iguais nunca nascem de um
   * reenvio.
   */
  async function restore(
    context: OrganizationContext,
    archiveId: string,
  ): Promise<{ inboxId: string; version: number }> {
    return withOrg(context, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `telegram-ticket-restore:${archiveId}`,
      ]);
      const found = (
        await client.query<{
          id: string;
          inbox_id: string;
          state: string;
          reason: string;
          recoverable_until: Date;
        }>(
          `select a.id,a.inbox_id,a.state,a.reason,a.recoverable_until
             from integration.telegram_ticket_archive a
            where a.organization_id=current_setting($1, true)::uuid and a.id=$2
            for update`,
          [ORGANIZATION_SETTING, archiveId],
        )
      ).rows[0];
      if (!found) throw new TelegramTicketError('TELEGRAM_TICKET_NOT_FOUND');
      if (found.state !== 'archived' || found.reason === 'duplicate')
        throw new TelegramTicketError('TELEGRAM_TICKET_NOT_RECOVERABLE');
      const until = toInstant(found.recoverable_until);
      if (!until || until.getTime() <= Date.now())
        throw new TelegramTicketError('TELEGRAM_TICKET_EXPIRED');
      const updated = await client.query<{ version: number }>(
        `update integration.inbox
            set state='review', error_code=null, telegram_queue_state='queued', telegram_queued_at=now(),
                telegram_duplicate_of=null, version=version+1, updated_at=now()
          where organization_id=current_setting($1, true)::uuid and id=$2
            and state in ('discarded','failed')
          returning version`,
        [ORGANIZATION_SETTING, found.inbox_id],
      );
      if (!updated.rows[0]) throw new TelegramTicketError('TELEGRAM_TICKET_STATE_CONFLICT');
      await client.query(
        `update integration.telegram_ticket_archive
            set state='restored', restored_at=now(), updated_at=now()
          where organization_id=current_setting($1, true)::uuid and id=$2`,
        [ORGANIZATION_SETTING, archiveId],
      );
      await audit(client, 'telegram.archive_restored', found.inbox_id, {
        withinRecoveryWindow: true,
      });
      return { inboxId: found.inbox_id, version: updated.rows[0]!.version };
    });
  }

  /** Arquivos recuperaveis da organizacao, mais recentes primeiro. */
  async function listArchive(
    context: OrganizationContext,
    limit = 50,
  ): Promise<
    {
      archiveId: string;
      inboxId: string;
      identity: string;
      reason: 'discarded' | 'duplicate' | 'superseded';
      archivedAt: string;
      recoverableUntil: string;
    }[]
  > {
    const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    return withOrg(
      context,
      async (client) => {
        const rows = (
          await client.query<{
            id: string;
            inbox_id: string;
            identity: string;
            reason: 'discarded' | 'duplicate' | 'superseded';
            archived_at: Date;
            recoverable_until: Date;
          }>(
            `select id,inbox_id,identity,reason,archived_at,recoverable_until
               from integration.telegram_ticket_archive
              where organization_id=current_setting($1, true)::uuid and state='archived'
              order by archived_at desc, id desc limit $2`,
            [ORGANIZATION_SETTING, bounded],
          )
        ).rows;
        return rows.map((row) => ({
          archiveId: row.id,
          inboxId: row.inbox_id,
          identity: row.identity,
          reason: row.reason,
          archivedAt: toIso(row.archived_at) ?? new Date(0).toISOString(),
          recoverableUntil: toIso(row.recoverable_until) ?? new Date(0).toISOString(),
        }));
      },
      { isolation: 'repeatable read' },
    );
  }

  /**
   * Retry EXPLICITO. Nenhum temporizador repete a chamada paga: quem pede e o
   * usuario, pelo preview, e a fila existente faz o resto.
   *
   * O reprocessamento volta o bilhete para `pending` e reinsere o pedido de
   * extracao na MESMA transacao, entao uma queda entre as duas operacoes nao
   * deixa o registro preso sem fila.
   */
  async function retry(
    context: OrganizationContext,
    inboxId: string,
    version: number,
  ): Promise<{ id: string; version: number; state: 'pending' }> {
    return withOrg(context, async (client) => {
      const row = (
        await client.query<{ state: string; version: number }>(
          'select state,version from integration.inbox where organization_id=current_setting($1, true)::uuid and id=$2 for update',
          [ORGANIZATION_SETTING, inboxId],
        )
      ).rows[0];
      if (!row) throw new TelegramTicketError('TELEGRAM_TICKET_NOT_FOUND');
      if (row.version !== version) throw new TelegramTicketError('TELEGRAM_TICKET_STATE_CONFLICT');
      if (row.state !== 'failed') throw new TelegramTicketError('TELEGRAM_TICKET_STATE_CONFLICT');
      const updated = await client.query<{ version: number }>(
        `update integration.inbox
            set state='pending', error_code=null, version=version+1, updated_at=now()
          where organization_id=current_setting($1, true)::uuid and id=$2
          returning version`,
        [ORGANIZATION_SETTING, inboxId],
      );
      // `extraction_request.id` não tem default no banco (só a PK uuid do
      // drizzle), então o gerador fica aqui — o mesmo caminho de `inbox.ts`.
      // Um pedido por bilhete: repetir o retry não duplica a fila.
      await client.query(
        `insert into integration.extraction_request(id,organization_id,inbox_id)
         select $1,current_setting($2, true)::uuid,$3
         where not exists (select 1 from integration.extraction_request
                            where organization_id=current_setting($2, true)::uuid and inbox_id=$3)`,
        [randomUUID(), ORGANIZATION_SETTING, inboxId],
      );
      await audit(client, 'telegram.ticket_retried', inboxId, { explicit: true });
      return { id: inboxId, version: updated.rows[0]!.version, state: 'pending' as const };
    });
  }

  /**
   * Fecha a janela dos arquivos expirados. O anexo continua sob a politica de
   * retencao da STK-G0-19 — o que muda aqui e so a promessa de recuperacao, que
   * passa a ser cumprida.
   */
  async function expireRecoveries(context: OrganizationContext): Promise<number> {
    return withOrg(context, async (client) => {
      const expired = await client.query<{ id: string }>(
        `update integration.telegram_ticket_archive
            set state='expired', updated_at=now()
          where organization_id=current_setting($1, true)::uuid
            and state='archived' and recoverable_until <= now()
          returning id`,
        [ORGANIZATION_SETTING],
      );
      return expired.rowCount ?? 0;
    });
  }

  return {
    enqueue,
    admitNext,
    publishPreview,
    releaseAdmission,
    preview,
    archive,
    restore,
    listArchive,
    retry,
    expireRecoveries,
  };
}

export type TelegramTicketService = ReturnType<typeof createTelegramTicketService>;

/**
 * Monta o preview a partir do rascunho canonico.
 *
 * Tudo aqui e LEITURA do estado ja gravado; nenhuma coluna financeira e
 * escrita. O preview diz exatamente o que o servidor sabe: `sentAt` e o
 * instante da mensagem original, `eventAt` so existe se o usuario ja o
 * declarou, e a duplicata e a decidida pela identidade deterministica.
 */
async function buildPreview(client: PoolClient, inboxId: string): Promise<TelegramTicketPreview> {
  const row = (await client.query<Row>(readRowSql, [ORGANIZATION_SETTING, inboxId])).rows[0];
  if (!row) throw new TelegramTicketError('TELEGRAM_TICKET_NOT_FOUND');
  const evidence =
    row.extraction && typeof row.extraction === 'object' && 'extraction' in row.extraction
      ? (row.extraction as { extraction: unknown }).extraction
      : row.extraction;
  const parsed = ticketExtractionSchema.safeParse(evidence);
  const extraction = parsed.success ? parsed.data : null;
  const overrides = readOverrides(row.metadata);
  const labels = parseCaption(row.caption);

  const fromExtraction = (extraction?.selections ?? []).map((item) => ({
    event: item.event ? normalizeEventLabel(item.event) : null,
    sport: item.sport,
    market: item.market ?? null,
    selection: item.selection ?? null,
    odds: item.odds,
  }));
  const declared = overrides.selections.length
    ? overrides.selections.map((item) => ({
        event: item.event ?? null,
        sport: overrides.sport,
        market: item.market ?? null,
        selection: item.selection ?? null,
        odds: null,
      }))
    : [];
  // A declaracao do usuario prevalece por posicao; o resto vem da extracao.
  const selections = (declared.length ? declared : fromExtraction)
    .map((item, index) => {
      const fallback = fromExtraction[index];
      return {
        event: item.event ?? fallback?.event ?? null,
        sport: item.sport ?? fallback?.sport ?? null,
        market: item.market ?? fallback?.market ?? null,
        selection: item.selection ?? fallback?.selection ?? null,
        odds: item.odds ?? fallback?.odds ?? null,
      };
    })
    .slice(0, 60);

  const stake = overrides.stake ?? extraction?.stake ?? null;
  const odds = overrides.odds ?? extraction?.odds ?? null;
  const origin: BetOrigin | null =
    row.bet_origin === 'real' || row.bet_origin === 'freebet' || row.bet_origin === 'hibrida'
      ? row.bet_origin
      : null;
  const kind = classifyTicketKind(selections);
  const duplicate = await findDuplicateByIdentity(
    client,
    inboxId,
    row,
    extraction?.reference ?? '',
  );

  const failed = row.state === 'failed';
  const terminal = row.state === 'discarded' || row.state === 'imported';
  const actions: TelegramTicketPreview['actions'] = terminal
    ? []
    : failed
      ? ['edit', 'discard', 'retry']
      : ['confirm', 'edit', 'discard'];

  const blockedReason = failed
    ? 'EXTRACTION_FAILED'
    : !extraction
      ? 'EXTRACTION_PENDING'
      : !stake || !odds
        ? 'FIELDS_PENDING'
        : null;

  return telegramTicketPreviewSchema.parse({
    id: row.id,
    version: row.version,
    state: row.state as TelegramTicketPreview['state'],
    queueState: row.telegram_queue_state as TelegramTicketPreview['queueState'],
    // A data de envio e o instante da MENSAGEM ORIGINAL e nao muda nunca.
    sentAt: toIso(row.telegram_received_at),
    // A data do evento e outro campo: nasce nula e so existe por declaracao.
    eventAt: toIso(row.event_at),
    eventDateStatus: row.event_date_status === 'confirmed' ? 'confirmed' : 'pending',
    bookmaker: row.bookmaker ?? labels.bookmaker ?? null,
    tipster: row.tipster ?? labels.tipster ?? null,
    stake,
    odds,
    reference: extraction?.reference ?? null,
    kind,
    origin,
    selections,
    potentialReturn: stake && odds ? potentialReturnFor(origin ?? 'real', stake, odds, null) : null,
    duplicate,
    archive: {
      archived: row.archive_state !== null,
      reason: (row.archive_reason as TelegramTicketPreview['archive']['reason']) ?? null,
      recoverableUntil: toIso(row.archive_recoverable_until),
      restored: row.archive_restored_at !== null,
    },
    actions,
    blockedReason,
  });
}

/**
 * Duplicata por identidade DETERMINISTICA + contexto.
 *
 * A identidade (imagem + contexto) e a regra de primeira linha: a mesma foto
 * com o mesmo contexto e duplicata mesmo com outro id de mensagem e outro
 * instante. A referencia declarada entra como motivo ADICIONAL, nunca como
 * substituto — o card proibe decidir por timestamp, e nenhuma regra aqui usa o
 * instante da mensagem.
 */
async function findDuplicateByIdentity(
  client: PoolClient,
  inboxId: string,
  row: Row,
  reference: string,
): Promise<TelegramPreviewDuplicate> {
  const reasons: TelegramPreviewDuplicate['reasons'] = [];
  let ofImportId: string | null = null;
  if (row.telegram_duplicate_of) {
    ofImportId = row.telegram_duplicate_of;
    reasons.push('image');
  } else if (row.telegram_identity) {
    const twin = (
      await client.query<{ id: string }>(
        `select id from integration.inbox
          where organization_id=current_setting($1, true)::uuid and telegram_identity=$2
            and id<>$3 and state not in ('discarded')
          order by created_at asc, id asc limit 1`,
        [ORGANIZATION_SETTING, row.telegram_identity, inboxId],
      )
    ).rows[0];
    if (twin) {
      ofImportId = twin.id;
      reasons.push('image');
    }
  }
  if (reference.trim().length >= 3) {
    const byReference = (
      await client.query<{ id: string }>(
        `select i.id from integration.inbox i
           join finance.bet b on b.id=i.imported_bet_id and b.organization_id=i.organization_id
          where i.organization_id=current_setting($1, true)::uuid and i.id<>$3
            and b.reference<>'' and lower(trim(b.reference))=lower(trim($2))`,
        [ORGANIZATION_SETTING, reference, inboxId],
      )
    ).rows[0];
    if (byReference) {
      reasons.push('reference');
      ofImportId = ofImportId ?? byReference.id;
    }
  }
  return { detected: reasons.length > 0, ofImportId, reasons };
}
