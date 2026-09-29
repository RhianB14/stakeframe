/**
 * STK-F2-09 — o serviço de importação por arquivo: dois caminhos (template
 * Stakeframe e CSV genérico com mapeamento declarado), preview linha a linha,
 * commit idempotente do lote, resultado parcial explícito e rollback antes da
 * confirmação.
 *
 * Cinco invariantes estruturam este módulo, e nenhuma delas é convenção de
 * quem chama:
 *
 *  1) O PREVIEW é a fronteira financeira. `preview()` não escreve em
 *     `finance.bet`, `finance.journal` nem `finance.posting`: ele lê o catálogo
 *     ativo e os créditos válidos, valida cada linha contra a MESMA regra que o
 *     comando financeiro vai aplicar, e devolve o veredito linha a linha.
 *
 *  2) A IDENTIDADE do lote é o CONTEÚDO, não o horário. A identidade é
 *     `SHA-256(conteúdo ‖ mapeamento efetivo ‖ origem)`: repetir o upload do
 *     MESMO arquivo com o MESMO mapeamento devolve o MESMO lote. É a mesma
 *     ideia da duplicata determinística da F2-05, com um campo a menos que
 *     varia — o id da requisição nunca entra.
 *
 *  3) O COMMIT USA O COMANDO FINANCEIRO CANÔNICO. Nada aqui escreve
 *     `finance.bet` por conta própria: cada aposta do lote entra por
 *     `executeFinancialCommand` com `bet.create`, que já valida catálogo ativo,
 *     unidade do mês, crédito, exposição e auditoria. Uma importação paralela
 *     de `bet.create` seria um segundo caminho de escrita financeira com as
 *     próprias regras — e a origem seria a primeira divergência.
 *
 *  4) O COMMIT É IDEMPOTENTE POR CHAVE. O recibo do lote e o recibo do comando
 *     financeiro são gravados na MESMA transação, com chaves derivadas uma da
 *     outra: repetir a confirmação devolve o resultado gravado, e a mesma chave
 *     com outro conteúdo é conflito, não um segundo lançamento.
 *
 *  5) O ROLLBACK REVERTE, não apaga. Cada aposta do lote carrega
 *     `import_batch_id` e o estorno sai pelo MESMO caminho de `bet.cancel`:
 *     journal de reversão + estado `cancelled`. O registro do fato permanece, e
 *     é isso que mantém exposição e histórico coerentes depois de um lote que o
 *     usuário decidiu desfazer.
 *
 * A origem (`stakeframe_template` | `csv_generic`) é gravada em CADA aposta:
 * é a marcação que responde "de onde veio este lançamento" para sempre, sem
 * depender de o arquivo existir.
 *
 * Nada aqui chama fornecedor, não há parser de concorrente, não há API de casa e
 * não há SSE: o progresso do job é lido no próprio estado do lote.
 */

import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  cents,
  detectDelimiter,
  importGroupKey,
  importRowDisposition,
  importRowInputSchema,
  missingRequiredColumns,
  normalizeLookup,
  parseCsvRows,
  parseImportOrigin,
  parseImportPlacedAt,
  resolveMapping,
  saoPauloDate,
  suggestMapping,
  type FinanceCommand,
  type ImportBatchResult,
  type ImportColumn,
  type ImportMapping,
  type ImportPreview,
  type ImportRowErrorCode,
  type ImportRowInput,
  type ImportRowPreview,
  type ImportTemplate,
} from '@stakeframe/shared';
import type { Database } from './index.js';
import { createTenantContext, type OrganizationContext } from './tenant-context.js';
import { executeFinancialCommand } from './finance-transaction.js';
import type { SettingsRow } from './finance-core.js';

export type ImportBatchErrorCode =
  | 'IMPORT_BATCH_NOT_FOUND'
  | 'IMPORT_BATCH_STATE_CONFLICT'
  | 'IMPORT_BATCH_ALREADY_COMMITTED'
  | 'IMPORT_CSV_MALFORMED'
  | 'IMPORT_MAPPING_CONFLICT'
  | 'IMPORT_NOT_INITIALIZED'
  | 'IMPORT_BOOKMAKER_UNRESOLVED'
  | 'IMPORT_FREEBET_UNRESOLVED';

export const IMPORT_BATCH_ERROR_CODES = [
  'IMPORT_BATCH_NOT_FOUND',
  'IMPORT_BATCH_STATE_CONFLICT',
  'IMPORT_BATCH_ALREADY_COMMITTED',
  'IMPORT_CSV_MALFORMED',
  'IMPORT_MAPPING_CONFLICT',
  'IMPORT_NOT_INITIALIZED',
  'IMPORT_BOOKMAKER_UNRESOLVED',
  'IMPORT_FREEBET_UNRESOLVED',
] as const;

/**
 * Erro estável e sanitizado: a mensagem É o código, então nenhum valor do
 * arquivo, nome de casa ou id de usuário chega a log ou resposta.
 */
export class ImportBatchError extends Error {
  constructor(public readonly code: ImportBatchErrorCode) {
    super(code);
    this.name = 'ImportBatchError';
  }
}

/** O serviço financeiro exige o lock de `settings` antes de qualquer comando. */
const LOCK_SETTINGS_SQL = `select * from finance.settings
  where organization_id=current_setting($$app.organization_id$$, true)::uuid for update`;
const READ_SETTINGS_SQL = `select * from finance.settings
  where organization_id=current_setting($$app.organization_id$$, true)::uuid`;

type BatchRow = {
  id: string;
  version: number;
  state: string;
  origin: string;
  filename: string;
  total: number;
  committed: number;
  skipped: number;
  content_sha256: string;
  mapping: ImportMapping | null;
};

type CatalogRow = { id: string; name: string; kind: string; active: boolean };
type CatalogSources = {
  rows: CatalogRow[];
  aliases: { catalog_id: string; alias: string }[];
};

/** O TEMPLATE do produto: cabeçalhos canônicos e uma linha de exemplo fictícia. */
export function buildImportTemplate(): ImportTemplate {
  const headers = [...IMPORT_COLUMNS];
  const sample = [
    'EXEMPLO-0001',
    'Bet365',
    'Tipster Exemplo',
    '50.00',
    '1.85',
    '10/10/2026 20:30',
    'Futebol',
    'Time Exemplo x Time Contrapartida',
    'Resultado da partida',
    'Vencedor',
    'real',
    '',
  ].join(',');
  return { filename: 'stakeframe-importacao.csv', headers, sample };
}

/**
 * A identidade do lote: hash do conteúdo com o mapeamento efetivo dentro.
 *
 * O mapeamento entra porque o MESMO arquivo lido com mapeamentos diferentes
 * produz lotes diferentes — e resultados parciais diferentes. Sem ele, reenviar
 * o arquivo com o mapeamento corrigido devolveria o preview antigo, que é
 * exatamente o defeito que o usuário está tentando corrigir.
 */
export function importBatchIdentity(
  content: string,
  mapping: ImportMapping | null,
  origin: string,
): string {
  return createHash('sha256')
    .update(content)
    .update('\u0000')
    .update(JSON.stringify(mapping ?? null))
    .update('\u0000')
    .update(origin)
    .digest('hex');
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Resolve um nome (ou alias) contra o catálogo ativo de um tipo. */
function resolveCatalog(
  sources: CatalogSources,
  kind: 'bookmaker' | 'tipster',
  value: string | null,
): CatalogRow | null {
  if (value === null) return null;
  const normalized = normalizeLookup(value);
  if (normalized === '') return null;
  const direct = sources.rows.find(
    (row) => row.kind === kind && row.active && normalizeLookup(row.name) === normalized,
  );
  if (direct) return direct;
  const alias = sources.aliases.find(
    (candidate) => normalizeLookup(candidate.alias) === normalized,
  );
  if (!alias) return null;
  return (
    sources.rows.find((row) => row.kind === kind && row.active && row.id === alias.catalog_id) ??
    null
  );
}

/** A identidade da linha DENTRO do arquivo, para detectar a duplicata dele mesmo. */
function rowFingerprint(row: ImportRowInput): string {
  return [
    normalizeLookup(row.bookmaker),
    normalizeLookup(row.reference ?? ''),
    row.placedAt,
    row.stake,
    row.odds,
    normalizeLookup(row.event),
    normalizeLookup(row.market),
    normalizeLookup(row.selection),
    row.betOrigin,
    row.freebetId ?? '',
  ].join('|');
}

export function createImportBatchService(database: Database) {
  const tenant = createTenantContext(database);
  const read = <T>(context: OrganizationContext, action: (client: PoolClient) => Promise<T>) =>
    tenant.withOrganizationTransaction(context, action, { isolation: 'repeatable read' });

  /** O catálogo ativo da organização, lido uma vez por preview. */
  async function catalogOf(client: PoolClient): Promise<CatalogSources> {
    const rows = (
      await client.query<CatalogRow>(
        'select id,name,kind,active from finance.catalog where organization_id=current_setting($$app.organization_id$$, true)::uuid',
      )
    ).rows;
    const aliases = (
      await client.query<{ catalog_id: string; alias: string }>(
        'select catalog_id,alias from finance.catalog_alias where organization_id=current_setting($$app.organization_id$$, true)::uuid',
      )
    ).rows;
    return { rows, aliases };
  }

  /**
   * Os créditos válidos, por casa, na data da aposta — a MESMA regra que o
   * `bet.create` aplica: casa compatível, crédito não usado e não expirado.
   */
  async function creditsByBookmaker(client: PoolClient): Promise<Map<string, Set<string>>> {
    const rows = (
      await client.query<{ id: string; bookmaker_id: string; expires_on: string }>(
        `select id,bookmaker_id,expires_on::text as expires_on from finance.freebet
          where organization_id=current_setting($$app.organization_id$$, true)::uuid and used_by is null`,
      )
    ).rows;
    const byBookmaker = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = byBookmaker.get(row.bookmaker_id) ?? new Set<string>();
      set.add(`${row.id}|${row.expires_on}`);
      byBookmaker.set(row.bookmaker_id, set);
    }
    return byBookmaker;
  }

  /**
   * A validação de UMA linha, com o mesmo conjunto de erros que a regra
   * financeira aplicaria. A ordem é deliberada: a casa ANTES do crédito, porque
   * o crédito é filtrado pela casa — validar crédito antes exigiria escolher
   * uma casa para filtrar, e escolher seria inventar.
   */
  function validateRow(
    cells: Map<ImportColumn, string>,
    catalog: CatalogSources,
    credits: Map<string, Set<string>>,
    defaults: {
      bookmaker: string | null;
      tipster: string | null;
      betOrigin: ImportRowInput['betOrigin'] | null;
      freebetId: string | null;
    },
    now: Date,
  ): { bet: ImportRowInput | null; errors: ImportRowErrorCode[] } {
    const errors: ImportRowErrorCode[] = [];
    const bookmakerCell = emptyToNull(cells.get('bookmaker')) ?? defaults.bookmaker;
    const tipsterCell = emptyToNull(cells.get('tipster')) ?? defaults.tipster;
    const bookmaker = resolveCatalog(catalog, 'bookmaker', bookmakerCell);
    if (!bookmaker) errors.push('IMPORT_BOOKMAKER_UNRESOLVED');
    // Tipster ausente NÃO é erro: ele é opcional no produto inteiro. Só vira
    // `IMPORT_TIPSTER_UNRESOLVED` quando a célula TRAZ um valor que não resolve
    // — nesse caso o arquivo AFIRMOU um cadastro que o produto não conhece, e
    // ignorá-lo registraria menos do que o usuário declarou.
    const tipster = tipsterCell === null ? null : resolveCatalog(catalog, 'tipster', tipsterCell);
    if (tipsterCell !== null && !tipster) errors.push('IMPORT_TIPSTER_UNRESOLVED');

    const stake = emptyToNull(cells.get('stake'));
    if (stake === null || !/^\d{1,12}(\.\d{1,2})?$/.test(stake) || cents(stake) <= 0n)
      errors.push('IMPORT_STAKE_INVALID');

    const odds = emptyToNull(cells.get('odds'));
    if (odds === null || !/^(0|[1-9]\d{0,5})(\.\d{1,4})?$/.test(odds) || Number(odds) < 1)
      errors.push('IMPORT_ODDS_INVALID');

    const placedAt = parseImportPlacedAt(cells.get('placed_at') ?? '');
    if (placedAt === null) errors.push('IMPORT_PLACED_AT_INVALID');
    else if (new Date(placedAt).getTime() > now.getTime()) errors.push('IMPORT_PLACED_AT_FUTURE');

    const event = emptyToNull(cells.get('event'));
    const market = emptyToNull(cells.get('market'));
    const selection = emptyToNull(cells.get('selection'));
    if (!event || !market || !selection) errors.push('IMPORT_SELECTION_MISSING');

    const originCell = emptyToNull(cells.get('bet_origin'));
    const parsedOrigin = originCell === null ? null : parseImportOrigin(originCell);
    if (originCell !== null && parsedOrigin === null) errors.push('IMPORT_ORIGIN_INVALID');
    const betOrigin = parsedOrigin ?? defaults.betOrigin ?? 'real';

    // A origem financeira é DECLARADA, e origem promocional SEM crédito é
    // recusada: é o que impede um arquivo de expor (ou de esconder) caixa real
    // por um crédito que o usuário não escolheu. O crédito é o id declarado na
    // coluna `freebet_id` ou no mapeamento — nunca "o primeiro disponível".
    const creditCell = emptyToNull(cells.get('freebet_id')) ?? defaults.freebetId;
    let freebetId: string | null = null;
    if (betOrigin !== 'real') {
      if (!bookmaker || placedAt === null) errors.push('IMPORT_FREEBET_UNRESOLVED');
      else {
        const available = credits.get(bookmaker.id) ?? new Set<string>();
        const day = saoPauloDate(new Date(placedAt));
        const resolved =
          creditCell === null
            ? null
            : [...available].find((entry) => entry.split('|')[0] === creditCell);
        if (creditCell === null) errors.push('IMPORT_FREEBET_REQUIRED');
        else if (!resolved || resolved.split('|')[1]! < day)
          errors.push('IMPORT_FREEBET_UNRESOLVED');
        else freebetId = creditCell;
      }
    } else if (creditCell !== null) {
      // Dinheiro real com crédito declarado é contradição, não aproximação: o
      // valor viria dos dois lugares ao mesmo tempo.
      errors.push('IMPORT_ROW_INCOMPATIBLE');
    }

    if (
      errors.length > 0 ||
      !bookmaker ||
      placedAt === null ||
      !event ||
      !market ||
      !selection ||
      stake === null ||
      odds === null
    )
      return { bet: null, errors };
    return {
      bet: importRowInputSchema.parse({
        bookmaker: bookmaker.name,
        tipster: tipster?.name ?? null,
        stake,
        odds,
        placedAt,
        reference: emptyToNull(cells.get('reference')),
        sport: emptyToNull(cells.get('sport')),
        event,
        market,
        selection,
        betOrigin,
        freebetId,
      }),
      errors,
    };
  }

  /** A célula de cada coluna canônica de uma linha do arquivo. */
  function cellsOf(row: string[], byColumn: Map<ImportColumn, number>): Map<ImportColumn, string> {
    const cells = new Map<ImportColumn, string>();
    for (const [column, index] of byColumn) cells.set(column, (row[index] ?? '').trim());
    return cells;
  }

  /**
   * A PREVIEW do lote: valida linha a linha, grava o lote em estado `preview` e
   * devolve o veredito. Nenhuma escrita financeira acontece aqui.
   *
   * O lote é gravado já no preview porque é ele que dá identidade ao trabalho:
   * reenviar o mesmo arquivo devolve o MESMO lote, e o commit e o rollback falam
   * desse id. Um preview sem identidade exigiria reenviar o arquivo inteiro para
   * confirmar, e o rollback não teria o que reverter.
   */
  async function preview(
    context: OrganizationContext,
    input: { content: string; filename: string; mapping: ImportMapping | null },
  ): Promise<{ batchId: string; version: number; preview: ImportPreview }> {
    const headerLine = firstLine(input.content);
    if (headerLine === null) throw new ImportBatchError('IMPORT_CSV_MALFORMED');
    const parsed = parseCsvRows(input.content, detectDelimiter(headerLine), MAX_IMPORT_ROWS + 1);
    if (parsed.rows.length === 0) throw new ImportBatchError('IMPORT_CSV_MALFORMED');
    const [headerRow, ...dataRows] = parsed.rows;
    const headers = (headerRow ?? []).map((header) => header.trim());

    let byColumn: Map<ImportColumn, number>;
    let origin: string;
    try {
      const resolved = resolveMapping(headers, input.mapping);
      byColumn = resolved.byColumn;
      origin = resolved.origin;
    } catch {
      throw new ImportBatchError('IMPORT_MAPPING_CONFLICT');
    }
    const missing = missingRequiredColumns(byColumn);
    // Sem mapeamento declarado, a ausência de coluna exigida é recusa do
    // arquivo: sem mapeamento, não há outra fonte para a coluna.
    if (input.mapping === null && missing.length > 0)
      throw new ImportBatchError('IMPORT_MAPPING_CONFLICT');
    const contentSha = importBatchIdentity(input.content, input.mapping, origin);

    return tenant.withOrganizationTransaction(context, async (client) => {
      const catalog = await catalogOf(client);
      const credits = await creditsByBookmaker(client);
      const now = (await client.query<{ now: Date }>('select now()')).rows[0]!.now;
      const defaults = {
        bookmaker: input.mapping?.defaultBookmaker ?? null,
        tipster: input.mapping?.defaultTipster ?? null,
        betOrigin: input.mapping?.defaultBetOrigin ?? null,
        freebetId: null,
      };
      const rows: ImportRowPreview[] = [];
      const skipped: { line: number; code: ImportRowErrorCode }[] = [];
      const seen = new Set<string>();
      const groups = new Set<string>();
      let valid = 0;
      let invalid = 0;
      let duplicates = 0;
      for (const [index, row] of dataRows.entries()) {
        const line = index + 2;
        if (index >= MAX_IMPORT_ROWS) {
          invalid += 1;
          skipped.push({ line, code: 'IMPORT_ROW_LIMIT_REACHED' });
          continue;
        }
        if (row.every((value) => value.trim() === '')) {
          invalid += 1;
          skipped.push({ line, code: 'IMPORT_ROW_EMPTY' });
          rows.push({ line, status: 'invalid', bet: null, errors: ['IMPORT_ROW_EMPTY'] });
          continue;
        }
        const { bet, errors } = validateRow(
          cellsOf(row, byColumn),
          catalog,
          credits,
          defaults,
          now,
        );
        if (!bet || errors.length > 0) {
          invalid += 1;
          for (const code of errors) skipped.push({ line, code });
          rows.push({ line, status: 'invalid', bet: null, errors });
          continue;
        }
        const fingerprint = rowFingerprint(bet);
        if (seen.has(fingerprint)) {
          duplicates += 1;
          skipped.push({ line, code: 'IMPORT_DUPLICATE' });
          rows.push({ line, status: 'duplicate', bet, errors: ['IMPORT_DUPLICATE'] });
          continue;
        }
        seen.add(fingerprint);
        const group = importGroupKey(bet);
        if (group === null) groups.add(`#${line}`);
        else groups.add(group);
        valid += 1;
        rows.push({ line, status: 'valid', bet, errors: [] });
      }
      await client.query(
        `insert into integration.import_batch
           (organization_id,version,state,origin,filename,content_sha256,mapping,
            total,valid,invalid,duplicates,rows,skipped_rows)
         values(current_setting($$app.organization_id$$, true)::uuid,1,'preview',$1,$2,$3,$4::jsonb,
                $5,$6,$7,$8,$9::jsonb,$10::jsonb)
         on conflict (organization_id,content_sha256) do update
           set version=integration.import_batch.version+1,
               total=excluded.total,valid=excluded.valid,invalid=excluded.invalid,
               duplicates=excluded.duplicates,rows=excluded.rows,skipped_rows=excluded.skipped_rows,
               state='preview',result=null,updated_at=now()`,
        [
          origin,
          input.filename.slice(0, 200),
          contentSha,
          JSON.stringify(input.mapping),
          dataRows.length,
          valid,
          invalid,
          duplicates,
          JSON.stringify(rows.slice(0, 200)),
          JSON.stringify(skipped.slice(0, MAX_IMPORT_ROWS)),
        ],
      );
      const saved = (
        await client.query<BatchRow>(
          `select id,version,state,origin,filename,total,committed,skipped,content_sha256,mapping
             from integration.import_batch
            where organization_id=current_setting($$app.organization_id$$, true)::uuid
              and content_sha256=$1`,
          [contentSha],
        )
      ).rows[0]!;
      return {
        batchId: saved.id,
        version: saved.version,
        preview: {
          headers,
          source: origin as ImportPreview['source'],
          total: dataRows.length,
          valid,
          invalid,
          duplicates,
          rows: rows.slice(0, 200),
          missing: missing as ImportColumn[],
          groups: groups.size,
          confirmable: valid > 0,
        },
      };
    });
  }

  /**
   * O COMMIT do lote: grava as apostas escolhidas pelo COMANDO FINANCEIRO
   * CANÔNICO, e na mesma transação marca o lote e grava o seu recibo.
   *
   * O commit NÃO reinterpreta o arquivo: grava exatamente as linhas que o
   * usuário viu e aprovou no preview. Reescrever a célula depois do preview faria
   * a aposta nascer de um dado que ele não leu.
   */
  async function commit(
    context: OrganizationContext,
    key: string,
    batchId: string,
    input: { version: number; lines?: number[] | undefined; reason: string },
  ): Promise<ImportBatchResult> {
    if (!/^[a-f0-9-]{36}$/i.test(key)) throw new ImportBatchError('IMPORT_BATCH_STATE_CONFLICT');
    return tenant.withOrganizationTransaction(context, async (client) => {
      const batch = (
        await client.query<BatchRow>(
          `select id,version,state,origin,filename,total,committed,skipped,content_sha256,mapping
             from integration.import_batch
            where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 for update`,
          [batchId],
        )
      ).rows[0];
      if (!batch) throw new ImportBatchError('IMPORT_BATCH_NOT_FOUND');
      const requestHash = createHash('sha256')
        .update(JSON.stringify({ batchId, lines: input.lines ?? null, reason: input.reason }))
        .digest('hex');
      // O recibo do lote ANTES da checagem de versão: um retry legítimo de uma
      // confirmação que já deu certo devolve o resultado gravado, e não falha
      // porque a versão do lote já subiu.
      const receipt = (
        await client.query<{ hash: string; result: ImportBatchResult }>(
          'select hash,result from integration.import_batch_receipt where organization_id=current_setting($$app.organization_id$$, true)::uuid and key=$1',
          [key],
        )
      ).rows[0];
      if (receipt) {
        if (receipt.hash !== requestHash)
          throw new ImportBatchError('IMPORT_BATCH_ALREADY_COMMITTED');
        return receipt.result;
      }
      if (batch.version !== input.version)
        throw new ImportBatchError('IMPORT_BATCH_STATE_CONFLICT');
      if (batch.state === 'rolled_back') throw new ImportBatchError('IMPORT_BATCH_STATE_CONFLICT');
      const stored = (
        await client.query<{
          rows: ImportRowPreview[];
          skipped: { line: number; code: ImportRowErrorCode }[];
        }>(
          'select rows,skipped_rows as skipped from integration.import_batch where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
          [batchId],
        )
      ).rows[0]!;
      const settings = (await client.query<SettingsRow>(LOCK_SETTINGS_SQL)).rows[0];
      if (!settings?.initialized) throw new ImportBatchError('IMPORT_NOT_INITIALIZED');
      const catalog = await catalogOf(client);
      const chosen = new Set(input.lines ?? []);
      const skipped = [...(stored.skipped ?? [])];
      // Um GRUPO por aposta: linhas com a mesma casa/referência/instante são uma
      // aposta só, e a stake e a odd vêm da primeira linha do grupo — as demais
      // contribuem com seleções. Uma linha do grupo com valor diferente recusa o
      // grupo INTEIRO, porque dividir exigiria saber qual valor é o da aposta, e
      // o arquivo não diz.
      const groups = new Map<string, ImportRowInput[]>();
      const groupLines = new Map<string, number[]>();
      for (const row of stored.rows ?? []) {
        if (chosen.size > 0 && !chosen.has(row.line)) continue;
        const disposition = importRowDisposition(row);
        if (!disposition.commit) {
          if (!skipped.some((entry) => entry.line === row.line))
            skipped.push({ line: row.line, code: disposition.code });
          continue;
        }
        const group = importGroupKey(disposition.bet) ?? `#${row.line}`;
        groups.set(group, [...(groups.get(group) ?? []), disposition.bet]);
        groupLines.set(group, [...(groupLines.get(group) ?? []), row.line]);
      }
      const applied: { lines: number[]; betId: string }[] = [];
      let version = settings.version;
      let index = 0;
      for (const [group, members] of groups) {
        const head = members[0]!;
        if (members.some((member) => member.stake !== head.stake || member.odds !== head.odds)) {
          for (const line of groupLines.get(group) ?? [])
            skipped.push({ line, code: 'IMPORT_ROW_INCOMPATIBLE' });
          continue;
        }
        const command = betCreateCommand(head, members, catalog);
        const applied_ = await executeFinancialCommand(
          client,
          context.userId,
          commandKey(key, index),
          { ...command, expectedVersion: version },
          { ...settings, version },
        );
        // O `bet.create` CONSOME um número de ticket a cada chamada, e a
        // aposta saiu com o valor que a linha de settings tinha. Reutilizar
        // esse snapshot para a próxima linha do lote daria o MESMO número a
        // duas apostas — e a unicidade de (organização, ticket) recusaria a
        // segunda. Por isso o contador é relido do banco a cada aposta.
        const current = (await client.query<SettingsRow>(READ_SETTINGS_SQL)).rows[0]!;
        settings.next_ticket_number = current.next_ticket_number;
        version = current.version;
        index += 1;
        applied.push({ lines: groupLines.get(group) ?? [], betId: applied_.id });
        await client.query(
          'update finance.bet set import_batch_id=$2,import_origin=$3 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
          [applied_.id, batch.id, batch.origin],
        );
      }
      if (applied.length === 0) throw new ImportBatchError('IMPORT_BATCH_STATE_CONFLICT');
      // Linhas do lote que não entraram (fora do recorte escolhido, ou recusadas
      // na revalidação do commit) contam como puladas, com o motivo explícito: o
      // total do lote continua fechando com committed + skipped.
      const accounted = new Set([
        ...applied.flatMap((entry) => entry.lines),
        ...skipped.map((entry) => entry.line),
      ]);
      for (const row of stored.rows ?? [])
        if (!accounted.has(row.line)) skipped.push({ line: row.line, code: 'IMPORT_ROW_EMPTY' });
      const now = (await client.query<{ now: Date }>('select now()')).rows[0]!.now;
      const committed = applied.reduce((sum, entry) => sum + entry.lines.length, 0);
      const state = skipped.length > 0 ? 'partially_committed' : 'committed';
      const result: ImportBatchResult = {
        batchId: batch.id,
        version: batch.version,
        state,
        origin: batch.origin as ImportBatchResult['origin'],
        total: batch.total,
        committed,
        skipped: skipped.length,
        skippedRows: skipped,
        bets: applied,
        partial: skipped.length > 0,
        committedAt: now.toISOString(),
        rolledBackAt: null,
      };
      await client.query(
        `update integration.import_batch
            set state=$2,version=version+1,committed=$3,skipped=$4,result=$5::jsonb,committed_at=$6,updated_at=now()
          where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1`,
        [batch.id, state, result.committed, result.skipped, JSON.stringify(result), now],
      );
      await client.query(
        `insert into integration.import_batch_receipt(organization_id,key,batch_id,hash,result)
         values(current_setting($$app.organization_id$$, true)::uuid,$1,$2,$3,$4::jsonb)
         on conflict (organization_id,key) do nothing`,
        [key, batch.id, requestHash, JSON.stringify(result)],
      );
      return result;
    });
  }

  /**
   * O comando `bet.create` do grupo, com as seleções de TODAS as suas linhas.
   *
   * A referência ausente ganha um identificador DERIVADO do lote e do grupo, e
   * não um valor lido do arquivo: uma referência inventada a partir da data
   * reapareceria no histórico como dado de origem que o usuário nunca informou.
   */
  function betCreateCommand(
    head: ImportRowInput,
    members: ImportRowInput[],
    catalog: CatalogSources,
  ): FinanceCommand {
    const bookmaker = catalog.rows.find(
      (row) => row.kind === 'bookmaker' && row.active && row.name === head.bookmaker,
    );
    if (!bookmaker) throw new ImportBatchError('IMPORT_BOOKMAKER_UNRESOLVED');
    const tipster =
      head.tipster === null
        ? null
        : (catalog.rows.find(
            (row) => row.kind === 'tipster' && row.active && row.name === head.tipster,
          )?.id ?? null);
    return {
      type: 'bet.create',
      expectedVersion: 1,
      bookmakerId: bookmaker.id,
      tipsterId: tipster,
      stake: head.stake,
      odds: head.odds,
      placedAt: head.placedAt,
      freebetId: head.freebetId,
      reference: head.reference ?? '',
      selections: members.map((member) => ({
        event: member.event,
        sport: member.sport,
        market: member.market,
        selection: member.selection,
        odds: null,
        eventDate: null,
        eventAt: null,
        dateStatus: 'pending' as const,
      })),
      // A unidade ausente NÃO recusa a aposta: o preview já declarou a linha
      // válida, e o produto registra o lançamento com a pendência
      // identificada — que é o mesmo contrato de `allowMissingUnit` do
      // formulário manual. O que não pode acontecer é inventar uma unidade.
      allowMissingUnit: true,
    };
  }

  /**
   * O ROLLBACK do lote: reverte as apostas que ele criou, uma a uma, pelo
   * caminho canônico do estorno (journal de reversão + `cancelled`).
   *
   * A aposta não é apagada: o lançamento permanece, e a sua reversão também.
   * Lotes já revertidos devolvem o resultado gravado em vez de estornar duas
   * vezes, porque o usuário pode clicar em "reverter" duas vezes.
   */
  async function rollback(
    context: OrganizationContext,
    key: string,
    batchId: string,
    input: { version: number },
  ): Promise<ImportBatchResult> {
    if (!/^[a-f0-9-]{36}$/i.test(key)) throw new ImportBatchError('IMPORT_BATCH_STATE_CONFLICT');
    return tenant.withOrganizationTransaction(context, async (client) => {
      const batch = (
        await client.query<BatchRow>(
          `select id,version,state,origin,filename,total,committed,skipped,content_sha256,mapping
             from integration.import_batch
            where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 for update`,
          [batchId],
        )
      ).rows[0];
      if (!batch) throw new ImportBatchError('IMPORT_BATCH_NOT_FOUND');
      if (batch.state === 'rolled_back') return readResult(client, batch);
      const now = (await client.query<{ now: Date }>('select now()')).rows[0]!.now;
      // A reversão de um lote em PREVIEW é só o descarte do rascunho: nada foi
      // gravado, e por isso ela é sempre possível, sem chave de idempotência.
      if (batch.state === 'preview') {
        const result = blankResult(batch, now.toISOString());
        await client.query(
          `update integration.import_batch
              set state='rolled_back',version=version+1,result=$2::jsonb,rolled_back_at=$3,updated_at=now()
            where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1`,
          [batch.id, JSON.stringify(result), now],
        );
        return result;
      }
      // A versão enviada é a que o cliente VIU (a do preview ou a do resultado
      // do commit). A linha pode estar um passo à frente, porque o commit a
      // incrementa ao gravar — então a recusa é "não pode ser uma versão que
      // ainda não existia", e não igualdade estrita. Sem essa tolerância, o
      // próprio commit tornaria a reversão impossível, que é o oposto do card.
      if (batch.version !== input.version && batch.version - 1 !== input.version)
        throw new ImportBatchError('IMPORT_BATCH_STATE_CONFLICT');
      const bets = (
        await client.query<{ id: string; state: string }>(
          `select id,state from finance.bet
            where organization_id=current_setting($$app.organization_id$$, true)::uuid
              and import_batch_id=$1 for update`,
          [batch.id],
        )
      ).rows;
      let index = 0;
      for (const bet of bets) {
        if (bet.state !== 'open') continue;
        // O contador de ticket NÃO é usado pelo `bet.cancel`, mas a versão de
        // settings é: cada comando a consome. Reler a cada estorno é o que
        // garante que um lote de N apostas reverta as N, sem VERSION_CONFLICT
        // no meio.
        const settings = { ...(await client.query<SettingsRow>(LOCK_SETTINGS_SQL)).rows[0]! };
        await executeFinancialCommand(
          client,
          context.userId,
          commandKey(key, index),
          {
            type: 'bet.cancel',
            expectedVersion: settings.version,
            id: bet.id,
            effectiveAt: now.toISOString(),
            reason: 'Reversão do lote de importação por arquivo',
          },
          settings,
        );
        index += 1;
      }
      const previous = await readResult(client, batch);
      const result: ImportBatchResult = {
        ...previous,
        state: 'rolled_back',
        version: batch.version,
        committed: 0,
        rolledBackAt: now.toISOString(),
      };
      await client.query(
        `update integration.import_batch
            set state='rolled_back',version=version+1,result=$2::jsonb,rolled_back_at=$3,updated_at=now()
          where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1`,
        [batch.id, JSON.stringify(result), now],
      );
      return result;
    });
  }

  function blankResult(batch: BatchRow, rolledBackAt: string): ImportBatchResult {
    return {
      batchId: batch.id,
      version: batch.version,
      state: 'rolled_back',
      origin: batch.origin as ImportBatchResult['origin'],
      total: batch.total,
      committed: 0,
      skipped: 0,
      skippedRows: [],
      bets: [],
      partial: false,
      committedAt: null,
      rolledBackAt,
    };
  }

  async function readResult(client: PoolClient, batch: BatchRow): Promise<ImportBatchResult> {
    const stored = (
      await client.query<{ result: ImportBatchResult | null }>(
        'select result from integration.import_batch where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
        [batch.id],
      )
    ).rows[0]!;
    if (stored.result) return stored.result;
    return {
      batchId: batch.id,
      version: batch.version,
      state: 'preview',
      origin: batch.origin as ImportBatchResult['origin'],
      total: batch.total,
      committed: 0,
      skipped: batch.skipped,
      skippedRows: [],
      bets: [],
      partial: false,
      committedAt: null,
      rolledBackAt: null,
    };
  }

  /** O LOTE e o seu resultado, lidos pelo estado do job (sem SSE). */
  async function detail(context: OrganizationContext, batchId: string): Promise<ImportBatchResult> {
    return read(context, async (client) => {
      const batch = (
        await client.query<BatchRow>(
          `select id,version,state,origin,filename,total,committed,skipped,content_sha256,mapping
             from integration.import_batch
            where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1`,
          [batchId],
        )
      ).rows[0];
      if (!batch) throw new ImportBatchError('IMPORT_BATCH_NOT_FOUND');
      return readResult(client, batch);
    });
  }

  /** A lista de lotes, para o cliente acompanhar o progresso dos trabalhos. */
  async function list(context: OrganizationContext) {
    return read(context, async (client) => {
      const items = (
        await client.query<{
          id: string;
          version: number;
          state: string;
          origin: string;
          filename: string;
          total: number;
          committed: number;
          skipped: number;
          created_at: Date;
        }>(
          `select id,version,state,origin,filename,total,committed,skipped,created_at
             from integration.import_batch
            where organization_id=current_setting($$app.organization_id$$, true)::uuid
            order by created_at desc limit 100`,
        )
      ).rows;
      return {
        items: items.map((row) => ({
          id: row.id,
          version: row.version,
          state: row.state as ImportBatchResult['state'],
          origin: row.origin as ImportBatchResult['origin'],
          filename: row.filename,
          total: row.total,
          committed: row.committed,
          skipped: row.skipped,
          createdAt: row.created_at.toISOString(),
        })),
      };
    });
  }

  return {
    /** O contexto canônico do usuário autenticado, provisionado no primeiro uso. */
    ensureContext(userId: string) {
      return tenant.ensureOrganizationMembership(userId);
    },
    preview,
    commit,
    rollback,
    detail,
    list,
    template: buildImportTemplate,
    suggestions: suggestMapping,
  };
}

/**
 * A chave idempotente de cada comando financeiro do lote, derivada da chave da
 * CONFIRMAÇÃO e do índice do grupo.
 *
 * Derivar da confirmação (e não gerar uma chave nova) é o que faz o retry
 * reconvergir: a segunda tentativa percorre os mesmos grupos, na mesma ordem, e
 * cada `bet.create` encontra o recibo que a primeira gravação deixou.
 */
function commandKey(key: string, index: number): string {
  const hash = createHash('sha256').update(`${key}|${index}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function firstLine(content: string): string | null {
  const index = content.search(/\r|\n/);
  const line = index === -1 ? content : content.slice(0, index);
  return line.trim() === '' ? null : line;
}

export type ImportBatchService = ReturnType<typeof createImportBatchService>;
