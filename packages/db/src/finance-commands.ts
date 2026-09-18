import { randomUUID } from 'node:crypto';
import { cents, money, saoPauloDate, type FinanceCommand } from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import { findDuplicates } from './import-review.js';
import { enqueueExtraction } from './inbox.js';
import { enqueueBetSync, enqueueCleanupForBet, enqueueOutbox } from './telegram-sync.js';
import { updateEvent } from './events.js';
import {
  FinanceError,
  accountByKind,
  cashAccount,
  accountBalance,
  activeCatalog,
  replaceAliases,
  verifyPast,
  writeJournal,
  reverseJournal,
  saveSelections,
  getBetRow,
  insertUnit,
  type SettingsRow,
} from './finance-core.js';

// R9 — histórico de liquidação congela a aposta (parcial, integral ou
// revertida: o registro do fato permanece e não pode ser relabelado).
async function hasSettlementHistory(client: PoolClient, betId: string): Promise<boolean> {
  const row = (
    await client.query(
      'select 1 from finance.settlement where organization_id=current_setting($$app.organization_id$$, true)::uuid and bet_id=$1 limit 1',
      [betId],
    )
  ).rows[0];
  return row !== undefined;
}

export async function applyFinanceCommand(
  client: PoolClient,
  command: FinanceCommand,
  actor: string,
  settings: SettingsRow,
  now: Date,
): Promise<{ id: string; before: unknown }> {
  const type = command.type;
  if (type === 'bet.unit.resolve') {
    const before = await getBetRow(client, command.id);
    if (before.unit_amount && cents(before.unit_amount) > 0n)
      throw new FinanceError('STATE_CONFLICT');
    const month = saoPauloDate(before.placed_at).slice(0, 7);
    const unit = (
      await client.query<{ amount: string }>(
        'select amount from finance.monthly_unit where organization_id=current_setting($$app.organization_id$$, true)::uuid and month=$1',
        [month],
      )
    ).rows[0];
    if (!unit || cents(unit.amount) <= 0n) throw new FinanceError('UNIT_REQUIRED');
    await client.query(
      'update finance.bet set unit_month=$2,unit_amount=$3 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
      [before.id, month, unit.amount],
    );
    return { id: before.id, before };
  }
  if (type === 'event.update') return updateEvent(client, command);
  if (type === 'import.confirm' || type === 'import.discard' || type === 'import.retry') {
    const row = (
      await client.query<{
        id: string;
        state: string;
        version: number;
        attachment_id: string;
        extraction: unknown;
        bet_origin: string | null;
        freebet_id: string | null;
        telegram_chat_id: string | null;
        telegram_result_message_id: string | null;
      }>(
        'select id,state,version,attachment_id,extraction,bet_origin,freebet_id,telegram_chat_id,telegram_result_message_id from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 for update',
        [command.importId],
      )
    ).rows[0];
    if (!row) throw new FinanceError('NOT_FOUND');
    if (row.version !== command.expectedInboxVersion) throw new FinanceError('VERSION_CONFLICT');
    if (!['pending', 'review', 'failed'].includes(row.state))
      throw new FinanceError('STATE_CONFLICT');
    if (type === 'import.discard') {
      await client.query(
        'delete from integration.extraction_request where organization_id=current_setting($$app.organization_id$$, true)::uuid and inbox_id=$1',
        [row.id],
      );
      const discarded = await client.query<{ version: number }>(
        "update integration.inbox set state='discarded',version=version+1,telegram_sync_state=case when telegram_chat_id is null then telegram_sync_state else 'pending' end,updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 returning version",
        [row.id],
      );
      // R6: a resposta final do Telegram reflete o descarte (mesma transação).
      if (row.telegram_chat_id && row.telegram_result_message_id)
        await enqueueOutbox(client, row.id, 'edit_result_message', discarded.rows[0]!.version);
      return { id: row.id, before: row };
    }
    const attachment = (
      await client.query<{ state: string }>(
        'select state from integration.attachment where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 for update',
        [row.attachment_id],
      )
    ).rows[0];
    if (!attachment || ['deleting', 'deleted'].includes(attachment.state))
      throw new FinanceError('STATE_CONFLICT');
    if (type === 'import.retry') {
      if (row.state === 'pending') throw new FinanceError('STATE_CONFLICT');
      await client.query(
        "update integration.inbox set state='pending',error_code=null,version=version+1,updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1",
        [row.id],
      );
      await enqueueExtraction(client, row.id);
      return { id: row.id, before: row };
    }
    if (!settings.initialized) throw new FinanceError('NOT_INITIALIZED');
    let betId: string;
    if (command.decision.kind === 'link') {
      await getBetRow(client, command.decision.betId);
      betId = command.decision.betId;
    } else {
      // STK-G0-19-R5: sem origem financeira declarada pelo usuário nenhuma
      // aposta financeira é criada (fail-closed); a escolha nunca vem da IA.
      const declared = command.decision.betOrigin ?? null;
      const canonical =
        row.bet_origin === 'real' || row.bet_origin === 'freebet' ? row.bet_origin : null;
      if (canonical !== null && declared !== null && canonical !== declared)
        throw new FinanceError('STATE_CONFLICT');
      // Crédito escolhido explicitamente pelo usuário também é declaração de
      // freebet (nunca inferência de IA); dinheiro real exige declaração.
      const inferred = command.decision.bet.freebetId === null ? null : 'freebet';
      const effective = declared ?? canonical ?? inferred;
      if (effective === null) throw new FinanceError('ORIGIN_REQUIRED');
      if (effective === 'real' && command.decision.bet.freebetId !== null)
        throw new FinanceError('STATE_CONFLICT');
      if (effective === 'freebet' && command.decision.bet.freebetId === null)
        throw new FinanceError('FREEBET_UNRESOLVED');
      if (
        effective === 'freebet' &&
        row.bet_origin === 'freebet' &&
        command.decision.bet.freebetId !== row.freebet_id
      )
        throw new FinanceError('FREEBET_UNRESOLVED');
      // Primeira confirmação: a origem escolhida vira estado canônico do
      // rascunho na MESMA transação (fail-closed se o update não aplicar).
      if (row.bet_origin === null) {
        const applied = await client.query(
          'update integration.inbox set bet_origin=$2,freebet_id=$3,updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and bet_origin is null',
          [row.id, effective, effective === 'freebet' ? command.decision.bet.freebetId : null],
        );
        if (applied.rowCount !== 1) throw new FinanceError('STATE_CONFLICT');
      }
      const duplicates = await findDuplicates(client, row.id, command.decision.bet);
      if (duplicates.length && command.decision.duplicateReason.trim().length < 3)
        throw new FinanceError('DUPLICATE_REVIEW_REQUIRED');
      const created = await applyFinanceCommand(
        client,
        { ...command.decision.bet, type: 'bet.create', expectedVersion: command.expectedVersion },
        actor,
        settings,
        now,
      );
      betId = created.id;
    }
    await client.query(
      'delete from integration.extraction_request where organization_id=current_setting($$app.organization_id$$, true)::uuid and inbox_id=$1',
      [row.id],
    );
    const imported = await client.query<{ version: number }>(
      "update integration.inbox set state='imported',imported_bet_id=$2,version=version+1,telegram_sync_state=case when telegram_chat_id is null then telegram_sync_state else 'pending' end,updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 returning version",
      [row.id, betId],
    );
    // A resposta final passa a refletir o registro importado (mesma transação).
    if (row.telegram_chat_id && row.telegram_result_message_id)
      await enqueueOutbox(client, row.id, 'edit_result_message', imported.rows[0]!.version);
    return { id: betId, before: row };
  }
  if (type === 'catalog.create') {
    const id = randomUUID();
    await client.query('insert into finance.catalog(id,kind,name) values($1,$2,$3)', [
      id,
      command.kind,
      command.name,
    ]);
    await replaceAliases(client, id, command.kind, command.name, command.aliases);
    if (command.kind === 'bookmaker')
      await client.query(
        "insert into finance.account(kind,name,bookmaker_id) values('bookmaker',$1,$2)",
        [command.name, id],
      );
    return { id, before: null };
  }
  if (type === 'catalog.update') {
    const before = (
      await client.query<{ kind: string }>(
        'select * from finance.catalog where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
        [command.id],
      )
    ).rows[0];
    if (!before) throw new FinanceError('NOT_FOUND');
    const aliases = (
      await client.query(
        'select label from finance.catalog_alias where organization_id=current_setting($$app.organization_id$$, true)::uuid and catalog_id=$1',
        [command.id],
      )
    ).rows;
    await replaceAliases(client, command.id, before.kind, command.name, command.aliases);
    await client.query(
      'update finance.catalog set name=$2,active=$3 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
      [command.id, command.name, command.active],
    );
    await client.query(
      'update finance.account set name=$2 where organization_id=current_setting($$app.organization_id$$, true)::uuid and bookmaker_id=$1',
      [command.id, command.name],
    );
    return { id: command.id, before: { ...before, aliases } };
  }
  if (type === 'bankroll.initialize') {
    if (settings.initialized || cents(command.unitPercent) > 10_000n)
      throw new FinanceError('INVALID_FINANCIAL_OPERATION');
    if (
      new Set(command.balances.map((value) => value.bookmakerId)).size !== command.balances.length
    )
      throw new FinanceError('INVALID_FINANCIAL_OPERATION');
    const reserve = await accountByKind(client, 'reserve');
    const counter = await accountByKind(client, 'counter');
    const postings = [{ accountId: reserve.id, amount: cents(command.reserve) }];
    for (const balance of command.balances) {
      await activeCatalog(client, balance.bookmakerId, 'bookmaker');
      const account = await accountByKind(client, 'bookmaker', balance.bookmakerId);
      postings.push({ accountId: account.id, amount: cents(balance.amount) });
    }
    const total = postings.reduce((sum, posting) => sum + posting.amount, 0n);
    postings.push({ accountId: counter.id, amount: -total });
    const id = await writeJournal(client, {
      kind: 'opening',
      effectiveAt: now,
      actor,
      reason: 'Saldos iniciais conferidos pelo proprietário',
      postings,
    });
    await client.query(
      'update finance.settings set initialized=true,unit_percent=$1,opened_at=$2 where organization_id=current_setting($$app.organization_id$$, true)::uuid',
      [money(cents(command.unitPercent)), now],
    );
    await insertUnit(client, saoPauloDate(now).slice(0, 7), total, command.unitPercent, 'initial');
    return { id, before: settings };
  }
  if (!settings.initialized) throw new FinanceError('NOT_INITIALIZED');
  if (type === 'settings.update') {
    if (cents(command.unitPercent) > 10_000n) throw new FinanceError('INVALID_FINANCIAL_OPERATION');
    await client.query(
      'update finance.settings set unit_percent=$1 where organization_id=current_setting($$app.organization_id$$, true)::uuid',
      [money(cents(command.unitPercent))],
    );
    return { id: 'settings', before: settings };
  }
  if (type === 'unit.set') {
    if (command.month > saoPauloDate(now).slice(0, 7))
      throw new FinanceError('INVALID_FINANCIAL_OPERATION');
    if (
      (
        await client.query(
          'select month from finance.monthly_unit where organization_id=current_setting($$app.organization_id$$, true)::uuid and month=$1',
          [command.month],
        )
      ).rowCount
    )
      throw new FinanceError('STATE_CONFLICT');
    // The base is an explicitly derived equivalent, not a reconstructed historical balance.
    const equivalentBase = (cents(command.amount) * 10_000n) / cents(settings.unit_percent);
    await insertUnit(
      client,
      command.month,
      equivalentBase,
      settings.unit_percent,
      'manual',
      money(cents(command.amount)),
    );
    return { id: command.month, before: null };
  }
  if (type === 'money.move') {
    const account = await cashAccount(client, command.accountId);
    const effectiveAt = verifyPast(command.effectiveAt, now);
    const before = await accountBalance(
      client,
      account.id,
      command.kind === 'reconcile' ? effectiveAt : undefined,
    );
    const amount = cents(command.amount);
    if (command.kind !== 'reconcile' && amount <= 0n)
      throw new FinanceError('INVALID_FINANCIAL_OPERATION');
    if (command.kind !== 'transfer' && command.targetAccountId !== null)
      throw new FinanceError('INVALID_FINANCIAL_OPERATION');
    let target = await accountByKind(client, 'counter');
    const movement =
      command.kind === 'withdrawal' || command.kind === 'transfer'
        ? -amount
        : command.kind === 'reconcile'
          ? amount - before
          : amount;
    if (command.kind === 'transfer') {
      if (!command.targetAccountId || command.targetAccountId === account.id)
        throw new FinanceError('INVALID_FINANCIAL_OPERATION');
      target = await cashAccount(client, command.targetAccountId);
    }
    if (movement === 0n) throw new FinanceError('INVALID_FINANCIAL_OPERATION');
    const id = await writeJournal(client, {
      kind: command.kind,
      effectiveAt,
      actor,
      reason: command.reason,
      postings: [
        { accountId: account.id, amount: movement },
        { accountId: target.id, amount: -movement },
      ],
    });
    return { id, before: { accountId: account.id, balance: money(before) } };
  }
  if (type === 'journal.reverse') {
    const row = (
      await client.query<{ kind: string; reversal_of: string | null }>(
        'select * from finance.journal where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
        [command.id],
      )
    ).rows[0];
    if (!row) throw new FinanceError('NOT_FOUND');
    if (!['deposit', 'withdrawal', 'transfer', 'reconcile'].includes(row.kind) || row.reversal_of)
      throw new FinanceError('INVALID_FINANCIAL_OPERATION');
    const id = await reverseJournal(
      client,
      command.id,
      verifyPast(command.effectiveAt, now),
      actor,
      command.reason,
    );
    return { id, before: row };
  }
  if (type === 'freebet.create') {
    await activeCatalog(client, command.bookmakerId, 'bookmaker');
    const id = randomUUID();
    await client.query(
      'insert into finance.freebet(id,bookmaker_id,amount,expires_on,stake_returned,note) values($1,$2,$3,$4,$5,$6)',
      [
        id,
        command.bookmakerId,
        money(cents(command.amount)),
        command.expiresOn,
        command.stakeReturned,
        command.note,
      ],
    );
    return { id, before: null };
  }
  if (type === 'bet.create') {
    await activeCatalog(client, command.bookmakerId, 'bookmaker');
    if (command.tipsterId) await activeCatalog(client, command.tipsterId, 'tipster');
    const placedAt = verifyPast(command.placedAt, now);
    const month = saoPauloDate(placedAt).slice(0, 7);
    const unit = (
      await client.query<{ month: string; amount: string }>(
        'select month,amount from finance.monthly_unit where organization_id=current_setting($$app.organization_id$$, true)::uuid and month=$1',
        [month],
      )
    ).rows[0];
    const unitKnown = !!unit && cents(unit.amount) > 0n;
    if (!unitKnown && !command.allowMissingUnit) throw new FinanceError('UNIT_REQUIRED');
    const id = randomUUID();
    const stake = cents(command.stake);
    let stakeReturned = false;
    if (command.freebetId) {
      const promo = (
        await client.query<{
          amount: string;
          bookmaker_id: string;
          used_by: string | null;
          expires_on: string;
          stake_returned: boolean;
        }>(
          'select *, expires_on::text as expires_on from finance.freebet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 for update',
          [command.freebetId],
        )
      ).rows[0];
      if (
        !promo ||
        promo.bookmaker_id !== command.bookmakerId ||
        promo.used_by ||
        cents(promo.amount) !== stake ||
        promo.expires_on < saoPauloDate(placedAt)
      )
        throw new FinanceError('INVALID_FINANCIAL_OPERATION');
      stakeReturned = promo.stake_returned;
    }
    const house = await accountByKind(client, 'bookmaker', command.bookmakerId);
    const exposure = await accountByKind(client, 'exposure');
    const realStake = command.freebetId ? 0n : stake;
    const journalId = await writeJournal(client, {
      kind: 'bet_stake',
      effectiveAt: placedAt,
      actor,
      reason: command.freebetId ? 'Uso de crédito promocional' : 'Registro da aposta',
      postings: [
        { accountId: house.id, amount: -realStake },
        { accountId: exposure.id, amount: realStake },
      ],
    });
    await client.query(
      'insert into finance.bet(id,bookmaker_id,tipster_id,stake,odds,placed_at,freebet_id,promotional_stake_returned,reference,remaining,unit_month,unit_amount,stake_journal_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$4,$10,$11,$12)',
      [
        id,
        command.bookmakerId,
        command.tipsterId,
        money(stake),
        command.odds,
        placedAt,
        command.freebetId,
        stakeReturned,
        command.reference,
        unitKnown ? month : null,
        unitKnown ? unit.amount : null,
        journalId,
      ],
    );
    if (command.freebetId)
      await client.query(
        'update finance.freebet set used_by=$2 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
        [command.freebetId, id],
      );
    await saveSelections(client, id, command.selections);
    return { id, before: null };
  }
  if (type === 'bet.update') {
    const before = await getBetRow(client, command.id);
    if (before.state === 'cancelled') throw new FinanceError('STATE_CONFLICT');
    if (command.tipsterId) await activeCatalog(client, command.tipsterId, 'tipster');
    const selections = (
      await client.query(
        'select * from finance.selection where organization_id=current_setting($$app.organization_id$$, true)::uuid and bet_id=$1 order by position',
        [command.id],
      )
    ).rows;
    await client.query(
      'update finance.bet set tipster_id=$2,reference=$3 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
      [command.id, command.tipsterId, command.reference],
    );
    await saveSelections(client, command.id, command.selections);
    // R5: a resposta final do Telegram reflete o registro canônico atualizado.
    await enqueueBetSync(client, command.id);
    return { id: command.id, before: { ...before, selections } };
  }
  if (type === 'bet.cancel') {
    const before = await getBetRow(client, command.id);
    const active = (
      await client.query(
        'select s.id from finance.settlement s left join finance.settlement_reversal r on r.settlement_id=s.id and r.organization_id=s.organization_id where s.organization_id=current_setting($$app.organization_id$$, true)::uuid and s.bet_id=$1 and r.settlement_id is null',
        [command.id],
      )
    ).rowCount;
    if (before.state !== 'open' || active) throw new FinanceError('STATE_CONFLICT');
    await reverseJournal(
      client,
      before.stake_journal_id,
      verifyPast(command.effectiveAt, now),
      actor,
      command.reason,
    );
    await client.query(
      "update finance.bet set state='cancelled',remaining=0 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1",
      [command.id],
    );
    // R5: saiu de pendente → limpeza do Telegram enfileirada na mesma transação.
    await enqueueCleanupForBet(client, command.id);
    if (before.freebet_id)
      await client.query(
        'update finance.freebet set used_by=null where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and used_by=$2',
        [before.freebet_id, command.id],
      );
    return { id: command.id, before };
  }
  if (type === 'bet.settle') {
    const before = await getBetRow(client, command.id);
    const principal = cents(command.closedPrincipal);
    const amount = cents(command.returnAmount);
    if (
      before.state !== 'open' ||
      principal > cents(before.remaining) ||
      (command.outcome === 'partial_cashout'
        ? principal >= cents(before.remaining)
        : principal !== cents(before.remaining))
    )
      throw new FinanceError('STATE_CONFLICT');
    const settledAt = verifyPast(command.settledAt, now);
    if (settledAt < before.placed_at) throw new FinanceError('INVALID_FINANCIAL_OPERATION');
    const house = await accountByKind(client, 'bookmaker', before.bookmaker_id);
    const exposure = await accountByKind(client, 'exposure');
    const counter = await accountByKind(client, 'counter');
    const realPrincipal = before.freebet_id ? 0n : principal;
    const journalId = await writeJournal(client, {
      kind: before.freebet_id ? 'freebet_return' : 'settlement',
      effectiveAt: settledAt,
      actor,
      reason: command.reason,
      postings: [
        { accountId: house.id, amount },
        { accountId: exposure.id, amount: -realPrincipal },
        { accountId: counter.id, amount: realPrincipal - amount },
      ],
    });
    const id = randomUUID();
    await client.query(
      'insert into finance.settlement(id,bet_id,outcome,closed_principal,real_principal_closed,return_amount,settled_at,journal_id,reason) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        id,
        command.id,
        command.outcome,
        money(principal),
        money(realPrincipal),
        money(amount),
        settledAt,
        journalId,
        command.reason,
      ],
    );
    const remaining = cents(before.remaining) - principal;
    await client.query(
      'update finance.bet set remaining=$2,state=$3 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
      [command.id, money(remaining), remaining === 0n ? 'settled' : 'open'],
    );
    // R5: liquidação total (saiu de pendente) → limpeza do Telegram.
    if (remaining === 0n) await enqueueCleanupForBet(client, command.id);
    // A full unused promotional stake voided without real payout can be used again.
    if (
      before.freebet_id &&
      command.outcome === 'void' &&
      amount === 0n &&
      principal === cents(before.stake)
    )
      await client.query(
        'update finance.freebet set used_by=null where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and used_by=$2',
        [before.freebet_id, command.id],
      );
    return { id, before };
  }
  if (type === 'bet.bookmaker') {
    // STK-G0-19-R8 — troca de casa canônica de aposta ABERTA. Dinheiro real:
    // journal de reclassificação move o valor entre as contas das casas sem
    // alterar banca nem exposição totais. Freebet: o crédito da casa antiga
    // nunca permanece vinculado à casa nova — um crédito compatível é exigido
    // NA MESMA operação, trocado atomicamente, ou a troca é recusada.
    const before = await getBetRow(client, command.id);
    if (before.state !== 'open') throw new FinanceError('STATE_CONFLICT');
    // STK-G0-19-R9 — liquidação (inclusive parcial) congela a aposta:
    // qualquer histórico de settlement (mesmo revertido — o fato histórico não
    // é relabelado) e qualquer remaining divergente do principal recusam a
    // operação sem nenhum efeito parcial.
    if (await hasSettlementHistory(client, command.id)) throw new FinanceError('STATE_CONFLICT');
    if (cents(before.remaining) !== cents(before.stake)) throw new FinanceError('STATE_CONFLICT');
    await activeCatalog(client, command.bookmakerId, 'bookmaker');
    if (before.bookmaker_id === command.bookmakerId) return { id: command.id, before };
    const remaining = cents(before.remaining);
    if (before.freebet_id) {
      if (!command.freebetId) throw new FinanceError('FREEBET_UNRESOLVED');
      const promo = (
        await client.query<{
          id: string;
          bookmaker_id: string;
          amount: string;
          used_by: string | null;
          stake_returned: boolean;
          expires_on: string;
        }>(
          'select id,bookmaker_id,amount,used_by,stake_returned,expires_on::text as expires_on from finance.freebet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 for update',
          [command.freebetId],
        )
      ).rows[0];
      if (
        !promo ||
        promo.bookmaker_id !== command.bookmakerId ||
        promo.used_by !== null ||
        cents(promo.amount) !== cents(before.stake) ||
        promo.expires_on < saoPauloDate(now)
      )
        throw new FinanceError('FREEBET_UNRESOLVED');
      await client.query(
        'update finance.freebet set used_by=null where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and used_by=$2',
        [before.freebet_id, command.id],
      );
      await client.query(
        'update finance.freebet set used_by=$2 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
        [command.freebetId, command.id],
      );
      await client.query(
        'update finance.bet set bookmaker_id=$2,freebet_id=$3,promotional_stake_returned=$4 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
        [command.id, command.bookmakerId, command.freebetId, promo.stake_returned],
      );
      // R9 — troca não monetária (crédito liberado/consumido): o registro fica
      // na auditoria e no recibo da operação; o ledger não recebe journal vazio.
    } else {
      const oldHouse = await accountByKind(client, 'bookmaker', before.bookmaker_id);
      const newHouse = await accountByKind(client, 'bookmaker', command.bookmakerId);
      await writeJournal(client, {
        kind: 'bet_bookmaker_change',
        effectiveAt: now,
        actor,
        reason: command.reason,
        postings: [
          { accountId: oldHouse.id, amount: remaining },
          { accountId: newHouse.id, amount: -remaining },
        ],
      });
      await client.query(
        'update finance.bet set bookmaker_id=$2 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
        [command.id, command.bookmakerId],
      );
    }
    await enqueueBetSync(client, command.id);
    return { id: command.id, before };
  }
  if (type === 'bet.origin') {
    // STK-G0-19-R8 — troca de origem canônica de aposta ABERTA. Journals
    // compensatórios (nunca reescrever journals antigos) e crédito
    // consumido/liberado atomicamente. Depois de liquidar/cancelar: recusa.
    const before = await getBetRow(client, command.id);
    if (before.state !== 'open') throw new FinanceError('STATE_CONFLICT');
    // STK-G0-19-R9 — liquidação (inclusive parcial) congela a aposta:
    // qualquer histórico de settlement (mesmo revertido — o fato histórico não
    // é relabelado) e qualquer remaining divergente do principal recusam a
    // operação sem nenhum efeito parcial.
    if (await hasSettlementHistory(client, command.id)) throw new FinanceError('STATE_CONFLICT');
    if (cents(before.remaining) !== cents(before.stake)) throw new FinanceError('STATE_CONFLICT');

    const current: 'real' | 'freebet' = before.freebet_id ? 'freebet' : 'real';
    if (current === command.kind) {
      if (command.kind === 'real' || (command.freebetId && command.freebetId === before.freebet_id))
        return { id: command.id, before };
      if (!command.freebetId) throw new FinanceError('FREEBET_UNRESOLVED');
    }
    const remaining = cents(before.remaining);
    if (command.kind === 'freebet') {
      if (!command.freebetId || command.freebetId === before.freebet_id)
        throw new FinanceError('FREEBET_UNRESOLVED');
      const promo = (
        await client.query<{
          amount: string;
          bookmaker_id: string;
          used_by: string | null;
          stake_returned: boolean;
          expires_on: string;
        }>(
          'select amount,bookmaker_id,used_by,stake_returned,expires_on::text as expires_on from finance.freebet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 for update',
          [command.freebetId],
        )
      ).rows[0];
      if (
        !promo ||
        promo.bookmaker_id !== before.bookmaker_id ||
        promo.used_by !== null ||
        cents(promo.amount) !== cents(before.stake) ||
        promo.expires_on < saoPauloDate(now)
      )
        throw new FinanceError('FREEBET_UNRESOLVED');
      if (current === 'freebet') {
        await client.query(
          'update finance.freebet set used_by=null where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and used_by=$2',
          [before.freebet_id, command.id],
        );
        // R9 — troca freebet→freebet sem movimentação: auditoria/recibo bastam.
      } else {
        // real → freebet: retira a exposição de dinheiro real (compensatório).
        const house = await accountByKind(client, 'bookmaker', before.bookmaker_id);
        const exposure = await accountByKind(client, 'exposure');
        await writeJournal(client, {
          kind: 'bet_origin_change',
          effectiveAt: now,
          actor,
          reason: command.reason,
          postings: [
            { accountId: exposure.id, amount: -remaining },
            { accountId: house.id, amount: remaining },
          ],
        });
      }
      await client.query(
        'update finance.freebet set used_by=$2 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
        [command.freebetId, command.id],
      );
      await client.query(
        'update finance.bet set freebet_id=$2,promotional_stake_returned=$3 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
        [command.id, command.freebetId, promo.stake_returned],
      );
    } else {
      // freebet → real: libera o crédito e cria a exposição de dinheiro real.
      const house = await accountByKind(client, 'bookmaker', before.bookmaker_id);
      const exposure = await accountByKind(client, 'exposure');
      await writeJournal(client, {
        kind: 'bet_origin_change',
        effectiveAt: now,
        actor,
        reason: command.reason,
        postings: [
          { accountId: house.id, amount: -remaining },
          { accountId: exposure.id, amount: remaining },
        ],
      });
      await client.query(
        'update finance.freebet set used_by=null where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and used_by=$2',
        [before.freebet_id, command.id],
      );
      await client.query(
        'update finance.bet set freebet_id=null,promotional_stake_returned=false where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
        [command.id],
      );
    }
    await enqueueBetSync(client, command.id);
    return { id: command.id, before };
  }
  if (type === 'settlement.reverse') {
    // Retention takes the settings lock first, then claims the attachment before external deletion.
    const deleting = await client.query(
      "select 1 from integration.inbox i join integration.attachment a on a.id=i.attachment_id and a.organization_id=i.organization_id join finance.settlement s on s.bet_id=i.imported_bet_id and s.organization_id=i.organization_id where i.organization_id=current_setting($$app.organization_id$$, true)::uuid and s.id=$1 and a.state='deleting'",
      [command.id],
    );
    if (deleting.rowCount) throw new FinanceError('STATE_CONFLICT');
    const row = (
      await client.query<{
        id: string;
        bet_id: string;
        closed_principal: string;
        journal_id: string;
      }>(
        'select * from finance.settlement where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
        [command.id],
      )
    ).rows[0];
    if (!row) throw new FinanceError('NOT_FOUND');
    if (
      (
        await client.query(
          'select settlement_id from finance.settlement_reversal where organization_id=current_setting($$app.organization_id$$, true)::uuid and settlement_id=$1',
          [command.id],
        )
      ).rowCount
    )
      throw new FinanceError('STATE_CONFLICT');
    const before = await getBetRow(client, row.bet_id);
    if (before.state === 'cancelled') throw new FinanceError('STATE_CONFLICT');
    if (before.freebet_id) {
      const credit = (
        await client.query<{ used_by: string | null }>(
          'select used_by from finance.freebet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
          [before.freebet_id],
        )
      ).rows[0]!;
      if (credit.used_by && credit.used_by !== before.id) throw new FinanceError('STATE_CONFLICT');
      await client.query(
        'update finance.freebet set used_by=$2 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
        [before.freebet_id, before.id],
      );
    }
    const journalId = await reverseJournal(
      client,
      row.journal_id,
      verifyPast(command.effectiveAt, now),
      actor,
      command.reason,
    );
    await client.query(
      'insert into finance.settlement_reversal(settlement_id,journal_id) values($1,$2)',
      [command.id, journalId],
    );
    await client.query(
      "update finance.bet set remaining=remaining+$2,state='open' where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1",
      [before.id, row.closed_principal],
    );
    return { id: journalId, before: { settlement: row, bet: before } };
  }
  throw new FinanceError('INVALID_FINANCIAL_OPERATION');
}
