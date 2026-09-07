import { randomUUID } from 'node:crypto';
import { cents, money, saoPauloDate, type FinanceCommand } from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import { findDuplicates } from './import-review.js';
import { enqueueExtraction } from './inbox.js';
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

export async function applyFinanceCommand(
  client: PoolClient,
  command: FinanceCommand,
  actor: string,
  settings: SettingsRow,
  now: Date,
): Promise<{ id: string; before: unknown }> {
  const type = command.type;
  if (type === 'import.confirm' || type === 'import.discard' || type === 'import.retry') {
    const row = (
      await client.query<{
        id: string;
        state: string;
        version: number;
        attachment_id: string;
        extraction: unknown;
      }>(
        'select id,state,version,attachment_id,extraction from integration.inbox where id=$1 for update',
        [command.importId],
      )
    ).rows[0];
    if (!row) throw new FinanceError('NOT_FOUND');
    if (row.version !== command.expectedInboxVersion) throw new FinanceError('VERSION_CONFLICT');
    if (!['pending', 'review', 'failed'].includes(row.state))
      throw new FinanceError('STATE_CONFLICT');
    if (type === 'import.discard') {
      await client.query('delete from integration.extraction_request where inbox_id=$1', [row.id]);
      await client.query(
        "update integration.inbox set state='discarded',version=version+1,updated_at=now() where id=$1",
        [row.id],
      );
      return { id: row.id, before: row };
    }
    const attachment = (
      await client.query<{ state: string }>(
        'select state from integration.attachment where id=$1 for update',
        [row.attachment_id],
      )
    ).rows[0];
    if (!attachment || ['deleting', 'deleted'].includes(attachment.state))
      throw new FinanceError('STATE_CONFLICT');
    if (type === 'import.retry') {
      if (row.state === 'pending') throw new FinanceError('STATE_CONFLICT');
      await client.query(
        "update integration.inbox set state='pending',error_code=null,version=version+1,updated_at=now() where id=$1",
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
    await client.query('delete from integration.extraction_request where inbox_id=$1', [row.id]);
    await client.query(
      "update integration.inbox set state='imported',imported_bet_id=$2,version=version+1,updated_at=now() where id=$1",
      [row.id, betId],
    );
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
      await client.query<{ kind: string }>('select * from finance.catalog where id=$1', [
        command.id,
      ])
    ).rows[0];
    if (!before) throw new FinanceError('NOT_FOUND');
    const aliases = (
      await client.query('select label from finance.catalog_alias where catalog_id=$1', [
        command.id,
      ])
    ).rows;
    await replaceAliases(client, command.id, before.kind, command.name, command.aliases);
    await client.query('update finance.catalog set name=$2,active=$3 where id=$1', [
      command.id,
      command.name,
      command.active,
    ]);
    await client.query('update finance.account set name=$2 where bookmaker_id=$1', [
      command.id,
      command.name,
    ]);
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
      'update finance.settings set initialized=true,unit_percent=$1,opened_at=$2 where id=1',
      [money(cents(command.unitPercent)), now],
    );
    await insertUnit(client, saoPauloDate(now).slice(0, 7), total, command.unitPercent, 'initial');
    return { id, before: settings };
  }
  if (!settings.initialized) throw new FinanceError('NOT_INITIALIZED');
  if (type === 'settings.update') {
    if (cents(command.unitPercent) > 10_000n) throw new FinanceError('INVALID_FINANCIAL_OPERATION');
    await client.query('update finance.settings set unit_percent=$1 where id=1', [
      money(cents(command.unitPercent)),
    ]);
    return { id: 'settings', before: settings };
  }
  if (type === 'unit.set') {
    if (command.month > saoPauloDate(now).slice(0, 7))
      throw new FinanceError('INVALID_FINANCIAL_OPERATION');
    if (
      (await client.query('select month from finance.monthly_unit where month=$1', [command.month]))
        .rowCount
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
        'select * from finance.journal where id=$1',
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
        'select month,amount from finance.monthly_unit where month=$1',
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
        }>('select *, expires_on::text as expires_on from finance.freebet where id=$1 for update', [
          command.freebetId,
        ])
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
      reason: command.freebetId ? 'Uso de crédito promocional' : 'Registro manual da aposta',
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
      await client.query('update finance.freebet set used_by=$2 where id=$1', [
        command.freebetId,
        id,
      ]);
    await saveSelections(client, id, command.selections);
    return { id, before: null };
  }
  if (type === 'bet.update') {
    const before = await getBetRow(client, command.id);
    if (before.state === 'cancelled') throw new FinanceError('STATE_CONFLICT');
    if (command.tipsterId) await activeCatalog(client, command.tipsterId, 'tipster');
    const selections = (
      await client.query('select * from finance.selection where bet_id=$1 order by position', [
        command.id,
      ])
    ).rows;
    await client.query('update finance.bet set tipster_id=$2,reference=$3 where id=$1', [
      command.id,
      command.tipsterId,
      command.reference,
    ]);
    await saveSelections(client, command.id, command.selections);
    return { id: command.id, before: { ...before, selections } };
  }
  if (type === 'bet.cancel') {
    const before = await getBetRow(client, command.id);
    const active = (
      await client.query(
        'select s.id from finance.settlement s left join finance.settlement_reversal r on r.settlement_id=s.id where s.bet_id=$1 and r.settlement_id is null',
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
    await client.query("update finance.bet set state='cancelled',remaining=0 where id=$1", [
      command.id,
    ]);
    if (before.freebet_id)
      await client.query('update finance.freebet set used_by=null where id=$1 and used_by=$2', [
        before.freebet_id,
        command.id,
      ]);
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
    await client.query('update finance.bet set remaining=$2,state=$3 where id=$1', [
      command.id,
      money(remaining),
      remaining === 0n ? 'settled' : 'open',
    ]);
    // A full unused promotional stake voided without real payout can be used again.
    if (
      before.freebet_id &&
      command.outcome === 'void' &&
      amount === 0n &&
      principal === cents(before.stake)
    )
      await client.query('update finance.freebet set used_by=null where id=$1 and used_by=$2', [
        before.freebet_id,
        command.id,
      ]);
    return { id, before };
  }
  if (type === 'settlement.reverse') {
    // Retention takes the settings lock first, then claims the attachment before external deletion.
    const deleting = await client.query(
      "select 1 from integration.inbox i join integration.attachment a on a.id=i.attachment_id join finance.settlement s on s.bet_id=i.imported_bet_id where s.id=$1 and a.state='deleting'",
      [command.id],
    );
    if (deleting.rowCount) throw new FinanceError('STATE_CONFLICT');
    const row = (
      await client.query<{
        id: string;
        bet_id: string;
        closed_principal: string;
        journal_id: string;
      }>('select * from finance.settlement where id=$1', [command.id])
    ).rows[0];
    if (!row) throw new FinanceError('NOT_FOUND');
    if (
      (
        await client.query(
          'select settlement_id from finance.settlement_reversal where settlement_id=$1',
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
          'select used_by from finance.freebet where id=$1',
          [before.freebet_id],
        )
      ).rows[0]!;
      if (credit.used_by && credit.used_by !== before.id) throw new FinanceError('STATE_CONFLICT');
      await client.query('update finance.freebet set used_by=$2 where id=$1', [
        before.freebet_id,
        before.id,
      ]);
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
    await client.query("update finance.bet set remaining=remaining+$2,state='open' where id=$1", [
      before.id,
      row.closed_principal,
    ]);
    return { id: journalId, before: { settlement: row, bet: before } };
  }
  throw new FinanceError('INVALID_FINANCIAL_OPERATION');
}
