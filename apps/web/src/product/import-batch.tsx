import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  IMPORT_COLUMNS,
  importBatchListSchema,
  importBatchProgress,
  importBatchResultSchema,
  importTemplateSchema,
  REQUIRED_IMPORT_COLUMNS,
  suggestMapping,
  type ImportBatchResult,
  type ImportColumn,
  type ImportMapping,
  type ImportPreview,
} from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { Field } from './forms.js';
import { ApiFailure, request } from './api.js';

// STK-F2-09 — a tela de importação por arquivo: dois caminhos, um preview.
//
// O que a tela NÃO faz é escolher a coluna por conta própria. A função de
// sugestão do servidor chega PRÉ-PREENCHIDA e o usuário confirma, corrige ou
// ignora; o que ele confirmar é o que o servidor aplica. Isso é o inverso do
// fallback automático de "deixa eu adivinhar", e é o que impede um histórico
// com "casa_1" e "casa_2" de virar duas apostas na conta errada.

/** Os textos dos códigos de linha, para o usuário ler o que houve. */
const rowErrors: Record<string, string> = {
  IMPORT_ROW_EMPTY: 'Linha vazia.',
  IMPORT_STAKE_INVALID: 'Valor inválido ou zerado.',
  IMPORT_ODDS_INVALID: 'Odd inválida ou abaixo de 1.',
  IMPORT_PLACED_AT_INVALID: 'Data e hora fora do formato aceito.',
  IMPORT_PLACED_AT_FUTURE: 'A data está no futuro.',
  IMPORT_BOOKMAKER_UNRESOLVED: 'Casa não encontrada no catálogo ativo.',
  IMPORT_TIPSTER_UNRESOLVED: 'Tipster não encontrado no catálogo ativo.',
  IMPORT_SELECTION_MISSING: 'Falta evento, mercado ou palpite.',
  IMPORT_ORIGIN_INVALID: 'Origem fora das opções aceitas.',
  IMPORT_FREEBET_REQUIRED: 'Informe o crédito de freebet usado nesta linha.',
  IMPORT_FREEBET_UNRESOLVED: 'O crédito informado não é válido para esta casa e data.',
  IMPORT_ROW_INCOMPATIBLE: 'Linhas do mesmo lançamento com valores diferentes.',
  IMPORT_DUPLICATE: 'Repetida dentro do próprio arquivo.',
  IMPORT_ROW_LIMIT_REACHED: 'Acima do limite de linhas por lote.',
};

const columnLabels: Record<ImportColumn, string> = {
  reference: 'Referência do bilhete',
  bookmaker: 'Casa de aposta',
  tipster: 'Tipster',
  stake: 'Valor apostado',
  odds: 'Odd',
  placed_at: 'Data e hora do registro',
  sport: 'Esporte',
  event: 'Evento',
  market: 'Mercado',
  selection: 'Palpite (seleção)',
  bet_origin: 'Origem (real ou freebet)',
  freebet_id: 'Crédito de freebet usado',
};

const readFile = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsText(file);
  });

export function ImportBatchForm({ onDone }: { onDone: () => void }) {
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [batch, setBatch] = useState<{
    batchId: string;
    version: number;
    preview: ImportPreview;
  } | null>(null);
  const [result, setResult] = useState<ImportBatchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('Importação de histórico por arquivo');

  // O template é um recurso do SERVIDOR: a lista e a ordem das colunas são o
  // contrato do produto, e o cliente nunca reconstrói essa lista.
  const template = useQuery({
    queryKey: ['product', 'import-template'],
    queryFn: () => request('/api/v1/import-batches/template', importTemplateSchema),
    staleTime: 5 * 60_000,
  });

  const suggestions = useMemo(() => (headers.length > 0 ? suggestMapping(headers) : {}), [headers]);

  const chosen = useMemo(() => {
    const byColumn = new Map<ImportColumn, string>();
    // O mapeamento declarado chega como lista `header -> coluna`; a tela o
    // EXIBE na direção inversa (`coluna -> header`), que é a que o usuário
    // está preenchendo. A inversão é de exibição, não de decisão.
    for (const entry of mapping?.mapping ?? []) byColumn.set(entry.column, entry.header);
    return byColumn;
  }, [mapping]);

  const pick = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setResult(null);
    setBatch(null);
    try {
      const text = await readFile(file);
      setContent(text);
      setFilename(file.name);
      // Os cabeçalhos vêm do próprio arquivo, lidos localmente: a tela de
      // mapeamento precisa mostrá-los antes de qualquer chamada ao servidor.
      setHeaders(firstHeaders(text));
      setMapping(null);
    } catch (reason_) {
      setError(reason_ instanceof Error ? reason_.message : 'Não foi possível ler o arquivo.');
    }
  };

  const send = async (payload: ImportMapping | null) => {
    if (busy || content === '') return;
    setBusy(true);
    setError(null);
    try {
      const response = await request<{
        batchId: string;
        version: number;
        preview: ImportPreview;
      }>(
        '/api/v1/import-batches/preview',
        {
          parse: (value) => value as { batchId: string; version: number; preview: ImportPreview },
        },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content,
            filename: filename || 'importacao.csv',
            mapping: payload,
          }),
        },
      );
      setBatch(response);
      if (payload) setMapping(payload);
    } catch (reason_) {
      setError(
        reason_ instanceof ApiFailure ? reason_.message : 'Não foi possível validar este arquivo.',
      );
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!batch || busy) return;
    setBusy(true);
    setError(null);
    // A chave é gerada uma vez e reaproveitada no retry: repetir a confirmação
    // devolve o MESMO resultado em vez de duplicar as apostas.
    const key = crypto.randomUUID();
    try {
      const response = await request(
        `/api/v1/import-batches/${batch.batchId}/commit`,
        importBatchResultSchema,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({ version: batch.version, reason }),
        },
      );
      setResult(response);
      setBatch(null);
    } catch (reason_) {
      setError(
        reason_ instanceof ApiFailure ? reason_.message : 'Não foi possível registrar este lote.',
      );
    } finally {
      setBusy(false);
    }
  };

  const rollback = async () => {
    if (!result || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await request(
          `/api/v1/import-batches/${result.batchId}/rollback`,
          importBatchResultSchema,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': crypto.randomUUID(),
            },
            body: JSON.stringify({ version: result.version }),
          },
        ),
      );
    } catch (reason_) {
      setError(
        reason_ instanceof ApiFailure ? reason_.message : 'Não foi possível reverter este lote.',
      );
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = () => {
    if (!template.data) return;
    const content = `${template.data.headers.join(',')}\n${template.data.sample}\n`;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = template.data.filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <form
      className="product-form"
      onSubmit={(event) => {
        event.preventDefault();
        void send(mapping);
      }}
    >
      <p className="form-intro">
        Importe um arquivo CSV do Stakeframe ou de qualquer histórico seu. Nada é registrado antes
        de você conferir o preview linha a linha.
      </p>
      <div className="button-row">
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={!template.data}
          onClick={downloadTemplate}
        >
          Baixar modelo do Stakeframe
        </Button>
      </div>
      {template.data ? (
        <p className="form-hint">As colunas do modelo são: {template.data.headers.join(', ')}.</p>
      ) : null}
      <Field label="Arquivo CSV" hint="Até 4 MB. O arquivo é seu e não é compartilhado.">
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={(event) => void pick(event.target.files?.[0] ?? null)}
        />
      </Field>
      {headers.length > 0 && !batch ? (
        <MappingEditor
          headers={headers}
          suggestions={suggestions}
          chosen={chosen}
          onChange={setMapping}
        />
      ) : null}
      {batch ? (
        <BatchPreview
          batch={batch}
          busy={busy}
          reason={reason}
          onReason={setReason}
          onCommit={commit}
        />
      ) : null}
      {result ? <BatchResult result={result} busy={busy} onRollback={rollback} /> : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          Fechar
        </Button>
        {batch ? null : (
          <Button type="submit" disabled={busy || content === ''}>
            {busy ? 'Validando…' : 'Validar arquivo'}
          </Button>
        )}
      </div>
    </form>
  );
}

/** Os cabeçalhos do arquivo, lidos localmente para a tela de mapeamento. */
function firstHeaders(content: string): string[] {
  const line = content.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (line.split(';').length ?? 0) > (line.split(',').length ?? 0) ? ';' : ',';
  return line
    .split(delimiter)
    .map((header) => header.trim().replace(/^"|"$/g, ''))
    .filter((header) => header !== '');
}

/**
 * O MAPEAMENTO VISUAL: cada coluna do arquivo e o campo do produto que ela
 * alimenta. A sugestão chega preenchida, e o usuário confirma — nenhuma escolha
 * é aplicada sem que ele a tenha feito.
 */
function MappingEditor({
  headers,
  suggestions,
  chosen,
  onChange,
}: {
  headers: string[];
  suggestions: Partial<Record<ImportColumn, string>>;
  chosen: Map<ImportColumn, string>;
  onChange: (mapping: ImportMapping) => void;
}) {
  const build = (next: Map<ImportColumn, string>) =>
    onChange({
      headers,
      mapping: [...next.entries()]
        .filter(([, header]) => header !== '')
        .map(([column, header]) => ({ header, column })),
      defaultBookmaker: null,
      defaultTipster: null,
      defaultBetOrigin: null,
    });
  return (
    <fieldset className="mapping-editor">
      <legend>Qual coluna do arquivo é cada campo</legend>
      <p className="form-hint">
        Preenchemos o que dá para reconhecer. Confira, corrija o que precisar e valide.
      </p>
      {IMPORT_COLUMNS.map((column) => {
        const used = new Set(chosen.values());
        const current = chosen.get(column) ?? suggestions[column] ?? '';
        return (
          <div key={column} className="mapping-row">
            <span className="mapping-label">
              {columnLabels[column]}
              {REQUIRED_IMPORT_COLUMNS.includes(column as never) ? (
                <em title="Campo obrigatório"> *</em>
              ) : null}
            </span>
            <select
              value={current}
              onChange={(event) => {
                const next = new Map(chosen);
                if (event.target.value === '') next.delete(column);
                else next.set(column, event.target.value);
                build(next);
              }}
            >
              <option value="">Não usar</option>
              {headers.map((header) => (
                <option
                  key={header}
                  value={header}
                  disabled={header !== current && used.has(header)}
                >
                  {header}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </fieldset>
  );
}

/** O PREVIEW linha a linha, com as contagens explícitas do resultado parcial. */
function BatchPreview({
  batch,
  busy,
  reason,
  onReason,
  onCommit,
}: {
  batch: { batchId: string; version: number; preview: ImportPreview };
  busy: boolean;
  reason: string;
  onReason: (value: string) => void;
  onCommit: () => void;
}) {
  const { preview } = batch;
  return (
    <section className="batch-preview">
      <h3>
        {preview.valid} pronta{preview.valid === 1 ? '' : 's'} · {preview.invalid} com problema
        {preview.invalid === 1 ? '' : 's'}
        {preview.duplicates > 0 ? ` · ${preview.duplicates} repetida(s)` : ''}
      </h3>
      <p className="form-hint">
        {preview.total} linha(s) no arquivo, formando {preview.groups} aposta(s).{' '}
        {preview.missing.length > 0
          ? `Falta a coluna obrigatória: ${preview.missing.map((column) => columnLabels[column]).join(', ')}.`
          : 'Nenhuma coluna obrigatória está faltando.'}
      </p>
      {preview.invalid > 0 ? (
        <p role="status" className="notice warning">
          As linhas com problema não serão registradas. O resultado do lote vai mostrar exatamente o
          que entrou e o que ficou de fora.
        </p>
      ) : null}
      <div className="batch-rows">
        {preview.rows.map((row) => (
          <div key={row.line} className={`batch-row ${row.status}`}>
            <span className="batch-line">Linha {row.line}</span>
            {row.bet ? (
              <span className="batch-bet">
                {row.bet.bookmaker} · {row.bet.selection} · R$ {row.bet.stake} · {row.bet.odds}
                {row.bet.reference ? ` · ${row.bet.reference}` : ''}
              </span>
            ) : (
              <span className="batch-bet">{rowErrors[row.errors[0] ?? ''] ?? 'Recusada.'}</span>
            )}
            {row.status !== 'valid' ? (
              <ul className="batch-errors">
                {row.errors.map((code) => (
                  <li key={code}>{rowErrors[code] ?? code}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
      <Field label="Motivo do registro" hint="Fica na auditoria junto com o lote.">
        <input value={reason} maxLength={500} onChange={(event) => onReason(event.target.value)} />
      </Field>
      <div className="form-actions">
        <Button type="button" disabled={busy || !preview.confirmable} onClick={onCommit}>
          {busy ? 'Registrando…' : `Registrar ${preview.valid} linha(s)`}
        </Button>
      </div>
    </section>
  );
}

/** O RESULTADO do lote, e a reversão disponível enquanto ele não foi confirmado. */
function BatchResult({
  result,
  busy,
  onRollback,
}: {
  result: ImportBatchResult;
  busy: boolean;
  onRollback: () => void;
}) {
  const progress = importBatchProgress(result);
  return (
    <section className="batch-result">
      <h3>{progress.label}</h3>
      <p className="form-hint">
        {result.committed} linha(s) registrada(s) e {result.skipped} não registrada(s) de{' '}
        {result.total}. {progress.percent}% concluído.
      </p>
      {result.partial ? (
        <p role="status" className="notice warning">
          Resultado parcial. As linhas abaixo ficaram de fora, cada uma com o motivo.
        </p>
      ) : null}
      {result.skippedRows.length > 0 ? (
        <ul className="batch-skipped">
          {result.skippedRows.map((entry) => (
            <li key={entry.line}>
              Linha {entry.line}: {rowErrors[entry.code] ?? entry.code}
            </li>
          ))}
        </ul>
      ) : null}
      {result.state !== 'rolled_back' ? (
        <div className="form-actions">
          <Button variant="secondary" disabled={busy} onClick={onRollback}>
            Reverter este lote
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** A lista de lotes, com o estado do job de cada um (sem SSE). */
export function ImportBatchList() {
  const query = useQuery({
    queryKey: ['product', 'import-batches'],
    queryFn: () => request('/api/v1/import-batches', importBatchListSchema),
  });
  if (query.isError)
    return (
      <p role="alert">
        Não foi possível carregar os lotes.{' '}
        <Button variant="ghost" onClick={() => void query.refetch()}>
          Tentar novamente
        </Button>
      </p>
    );
  if (!query.data) return <p role="status">Carregando lotes…</p>;
  if (query.data.items.length === 0) return null;
  const states: Record<string, string> = {
    preview: 'Aguardando confirmação',
    committed: 'Registrada',
    partially_committed: 'Registro parcial',
    rolled_back: 'Revertida',
  };
  return (
    <div className="import-list">
      {query.data.items.map((item) => (
        <div className="import-row" key={item.id}>
          <span>
            <strong>{item.filename}</strong>
            <small>
              {item.committed} de {item.total} registrada(s) · {item.skipped} não registrada(s)
            </small>
          </span>
          <span className="status-badge">{states[item.state] ?? item.state}</span>
        </div>
      ))}
    </div>
  );
}
