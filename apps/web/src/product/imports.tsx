import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  importPageSchema,
  importDetailSchema,
  betPageSchema,
  uploadResultSchema,
  MAX_IMAGE_BYTES,
  formatBRL,
  type Workspace,
  type ImportDetail,
  type AutomaticReason,
} from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { BetForm, Field } from './forms.js';
import { CommandForm, useFinanceActions } from './actions.js';
import { ApiFailure, request, dateLabel } from './api.js';
import { readPendingUpload, savePendingUpload, type PendingUpload } from './upload-storage.js';
import type { OpenModal } from './ProductApp.js';

const states = {
  pending: 'Aguardando extração',
  processing: 'Extraindo dados',
  review: 'Pronta para revisar',
  failed: 'Requer atenção',
  discarded: 'Descartada',
  imported: 'Registrada',
};
const extractionErrors: Record<string, string> = {
  AI_LOCAL_QUOTA_REACHED: 'O limite diário ou mensal de extrações foi atingido.',
  AI_OUTCOME_UNCERTAIN: 'Uma extração foi interrompida; o resultado é incerto.',
  AI_BUDGET_EXHAUSTED: 'O orçamento da IA foi atingido.',
  AI_RATE_LIMITED: 'O provedor limitou temporariamente as solicitações.',
  AI_CONNECTION_FAILED: 'Não foi possível obter a resposta da IA.',
  AI_EXTRACTION_INVALID: 'A resposta da IA não trouxe dados válidos para revisão.',
};
const automaticReasons: Record<AutomaticReason, string> = {
  IMPORTED:
    'Registrada automaticamente com um layout validado. Confira o comprovante e a aposta sempre que precisar.',
  LAYOUT_NOT_VALIDATED: 'Este layout ainda requer conferência manual antes do registro.',
  EXTRACTION_UNCERTAIN:
    'Há campos essenciais ausentes ou dúvidas na leitura. Confira os dados antes de registrar.',
  CAPTION_UNRESOLVED: 'A legenda precisa identificar um tipster e uma casa cadastrados.',
  BOOKMAKER_CONFLICT: 'A casa identificada no bilhete diverge da legenda ou do layout aprovado.',
  PLACED_AT_UNCERTAIN: 'A data ou o horário do registro precisa de conferência.',
  FREEBET_UNRESOLVED: 'O crédito promocional precisa ser escolhido e conferido.',
  RETURN_MISMATCH:
    'O retorno escrito diverge do cálculo pela stake e pela odd. Confira os valores e as regras da casa.',
  UNIT_REQUIRED: 'A unidade histórica da aposta precisa ser definida antes do registro.',
  DUPLICATE_REVIEW_REQUIRED:
    'Há uma possível duplicata. Confira os registros antes de criar outra aposta.',
  FINANCIAL_REVIEW_REQUIRED: 'O registro financeiro precisa de conferência manual.',
};
export function ImportsPage({ workspace, open }: { workspace: Workspace; open: OpenModal }) {
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['product', 'imports', state, page, workspace.version],
    queryFn: () =>
      request(
        `/api/v1/imports?page=${page}&pageSize=25${state ? `&state=${state}` : ''}`,
        importPageSchema,
      ),
    refetchInterval: 10_000,
  });
  return (
    <div className="panel">
      <div className="section-heading">
        <div>
          <h2>Comprovantes e revisão</h2>
          <p>Acompanhe os registros e confira os comprovantes que precisam de revisão.</p>
        </div>
        <Button onClick={() => open({ kind: 'upload' })}>Enviar comprovante</Button>
      </div>
      <div className="filter-bar">
        <Field label="Situação da importação">
          <select
            value={state}
            onChange={(event) => {
              setState(event.target.value);
              setPage(1);
            }}
          >
            <option value="">Todas</option>
            {Object.entries(states).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {query.isError ? (
        <p role="alert">
          Não foi possível carregar as importações.{' '}
          <Button
            variant="ghost"
            onClick={() => {
              void query.refetch();
            }}
          >
            Tentar novamente
          </Button>
        </p>
      ) : !query.data ? (
        <p role="status">Carregando importações…</p>
      ) : query.data.items.length === 0 ? (
        <div className="empty-state">
          <span aria-hidden="true">⇧</span>
          <h3>Nenhum comprovante nesta lista</h3>
          <p>Envie uma imagem ou use o Telegram configurado para começar.</p>
        </div>
      ) : (
        <div className="import-list">
          {query.data.items.map((item) => (
            <button
              type="button"
              className="import-row"
              key={item.id}
              onClick={() => open({ kind: 'import', id: item.id })}
            >
              <span className="import-symbol" aria-hidden="true">
                ▧
              </span>
              <span>
                <strong>
                  {item.caption.split('\n').filter(Boolean).join(' · ') ||
                    'Comprovante sem legenda'}
                </strong>
                <small>
                  {item.source === 'web' ? 'Enviado pelo site' : 'Telegram'} ·{' '}
                  {dateLabel(item.createdAt)}
                </small>
              </span>
              <span className={`status-badge ${item.state === 'failed' ? 'warning' : ''}`}>
                {states[item.state]}
              </span>
              <span aria-hidden="true">↗</span>
            </button>
          ))}
        </div>
      )}
      {query.data ? (
        <div className="pagination">
          <span>
            {query.data.total} registros · Página {page}
          </span>
          <div className="button-row">
            <Button
              variant="secondary"
              size="small"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              Anterior
            </Button>
            <Button
              variant="secondary"
              size="small"
              disabled={page * 25 >= query.data.total}
              onClick={() => setPage(page + 1)}
            >
              Próxima
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
export function UploadForm({
  owner,
  onDone,
  open,
}: {
  owner: string;
  onDone: () => void;
  open: OpenModal;
}) {
  const client = useQueryClient();
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const [ready, setReady] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => {
    let active = true;
    void readPendingUpload(owner)
      .then((value) => {
        if (active) {
          setPending(value);
          setReady(true);
        }
      })
      .catch((reason) => {
        if (active)
          setError(reason instanceof Error ? reason.message : 'Falha ao recuperar envio.');
      });
    return () => {
      active = false;
    };
  }, [owner]);
  const send = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let operation = pending;
    try {
      if (!operation) {
        if (
          !file ||
          !['image/png', 'image/jpeg'].includes(file.type) ||
          file.size > MAX_IMAGE_BYTES ||
          !file.size
        )
          throw new Error('Selecione um PNG ou JPEG com até 8 MiB.');
        const image = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]!);
          reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
          reader.readAsDataURL(file);
        });
        operation = { owner, key: crypto.randomUUID(), image, caption };
        await savePendingUpload(operation);
        setPending(operation);
      }
      const result = await request('/api/v1/imports', uploadResultSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': operation.key },
        body: JSON.stringify({ image: operation.image, caption: operation.caption }),
      });
      await savePendingUpload(null);
      setPending(null);
      await client.invalidateQueries({ queryKey: ['product', 'imports'] });
      open({ kind: 'import', id: result.id });
    } catch (reason) {
      if (
        reason instanceof ApiFailure &&
        reason.status >= 400 &&
        reason.status < 500 &&
        ![401, 403, 408, 429].includes(reason.status)
      ) {
        try {
          await savePendingUpload(null);
          setPending(null);
        } catch {
          setError(
            'Não foi possível limpar o envio recusado. Reabra a janela e verifique o envio.',
          );
          return;
        }
      }
      setError(reason instanceof Error ? reason.message : 'Não foi possível confirmar o envio.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <form
      className="product-form"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <p className="form-intro">
        PNG ou JPEG, até 8 MiB. A imagem fica privada e será revisada antes do registro da aposta.
      </p>
      {pending ? (
        <div className="notice warning" role="status">
          <p>
            Há um envio aguardando confirmação. Verifique com os mesmos dados para evitar uma nova
            importação.
          </p>
        </div>
      ) : (
        <fieldset disabled={busy || !ready}>
          <Field label="Imagem do comprovante">
            <input
              type="file"
              accept="image/png,image/jpeg"
              required
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </Field>
          <Field
            label="Legenda (opcional)"
            hint="Primeira linha: tipster. Segunda linha: casa de aposta."
          >
            <textarea
              rows={3}
              maxLength={1024}
              placeholder={'Nome do tipster\nNome da casa'}
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
            />
          </Field>
        </fieldset>
      )}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          Fechar
        </Button>
        <Button type="submit" disabled={busy || !ready}>
          {busy ? 'Enviando…' : pending ? 'Verificar envio' : 'Enviar para revisão'}
        </Button>
      </div>
    </form>
  );
}
export function ImportReview({
  id,
  workspace,
  open,
  onDone,
}: {
  id: string;
  workspace: Workspace;
  open: OpenModal;
  onDone: () => void;
}) {
  const query = useQuery({
    queryKey: ['product', 'import', id, workspace.version],
    queryFn: () => request(`/api/v1/imports/${id}`, importDetailSchema),
    refetchInterval: (query) => (query.state.data?.item.state === 'processing' ? 3000 : false),
  });
  if (query.isError)
    return (
      <p role="alert">
        Não foi possível carregar este comprovante.{' '}
        <Button
          onClick={() => {
            void query.refetch();
          }}
        >
          Tentar novamente
        </Button>
      </p>
    );
  if (!query.data) return <p role="status">Carregando comprovante…</p>;
  return (
    <>
      {query.data.item.state === 'pending' ? (
        <div className="button-row">
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void query.refetch();
            }}
          >
            Atualizar extração
          </Button>
        </div>
      ) : null}
      <ReviewContent
        key={`${id}:${query.data.item.version}`}
        detail={query.data}
        workspace={workspace}
        open={open}
        onDone={onDone}
      />
    </>
  );
}
function ReviewContent({
  detail,
  workspace,
  open,
  onDone,
}: {
  detail: ImportDetail;
  workspace: Workspace;
  open: OpenModal;
  onDone: () => void;
}) {
  const { item, extraction, matches } = detail;
  const [mode, setMode] = useState<'create' | 'link' | 'discard' | 'retry'>('create');
  const [target, setTarget] = useState(detail.duplicates[0]?.betId ?? '');
  const [reason, setReason] = useState('');
  const actions = useFinanceActions();
  const terminal = ['imported', 'discarded'].includes(item.state);
  return (
    <div className="import-review">
      <div className="review-evidence">
        {item.imageAvailable ? (
          <a
            href={`/api/v1/imports/${item.id}/image`}
            target="_blank"
            rel="noreferrer"
            className="ticket-preview"
          >
            <img
              src={`/api/v1/imports/${item.id}/image`}
              alt="Comprovante original enviado para revisão"
            />
            <span>Ampliar comprovante ↗</span>
          </a>
        ) : (
          <p className="notice">
            Imagem indisponível após a retenção. Os registros foram preservados.
          </p>
        )}
        <div>
          <span className="status-badge">{states[item.state]}</span>
          <p className="caption-evidence">{item.caption || 'Sem legenda'}</p>
          <small>
            {item.attempts} {item.attempts === 1 ? 'extração solicitada' : 'extrações solicitadas'}
          </small>
        </div>
      </div>
      {item.errorCode ? (
        <p className="notice warning" role="status">
          {extractionErrors[item.errorCode] ??
            'A extração não foi concluída. Você pode preencher os dados manualmente.'}
        </p>
      ) : null}
      {extraction && (item.state === 'review' || detail.automatic) ? (
        <p className="notice" role="status">
          {automaticReasons[detail.automaticReason]}
        </p>
      ) : null}
      {item.state === 'processing' ? (
        <p role="status" className="notice">
          Extração em andamento. Aguarde a conclusão para revisar ou descartar.
        </p>
      ) : terminal ? (
        <div className="notice">
          <p>
            {item.state === 'imported'
              ? 'Este comprovante está vinculado à aposta registrada.'
              : 'Este comprovante foi descartado.'}
          </p>
          {item.betId ? (
            <Button onClick={() => open({ kind: 'detail', id: item.betId! })}>Ver aposta</Button>
          ) : null}
        </div>
      ) : (
        <>
          {extraction ? (
            <div className="extraction-summary">
              <h3>O que foi lido no comprovante</h3>
              <p>
                Casa: {extraction.bookmaker ?? 'Não identificada'} · Data escrita:{' '}
                {extraction.placedAtText ?? 'Não identificada'} · Moeda:{' '}
                {extraction.currency ?? 'Não identificada'}
              </p>
              <p>
                Origem:{' '}
                {extraction.freebet === null
                  ? 'Não identificada'
                  : extraction.freebet
                    ? 'Freebet'
                    : 'Dinheiro real'}{' '}
                · Retorno potencial escrito: {extraction.potentialReturn ?? 'Não identificado'}
              </p>
              {extraction.selections.map((selection, index) => (
                <p key={index}>
                  Data escrita da seleção {index + 1}:{' '}
                  {selection.eventDateText ?? 'Não identificada'}
                </p>
              ))}
              {extraction.warnings.map((warning, index) => (
                <p className="warning-text" key={index}>
                  {warning}
                </p>
              ))}
            </div>
          ) : (
            <p className="notice">
              Você pode preencher e conferir os dados manualmente enquanto a extração está pendente.
            </p>
          )}
          {matches.conflict ? (
            <p className="notice warning" role="alert">
              A casa da legenda diverge da casa lida na imagem. Escolha a casa correta ao conferir o
              bilhete.
            </p>
          ) : null}
          {(detail.labels.tipster && !matches.tipsterId) ||
          (detail.labels.bookmaker && !matches.captionBookmakerId) ? (
            <p className="notice">
              Um nome da legenda ainda não está cadastrado. Confira casas, tipsters e aliases em
              Configurações.
            </p>
          ) : null}
          {detail.duplicates.length ? (
            <div className="duplicate-review">
              <h3>Possíveis bilhetes repetidos</h3>
              <p>
                Confira antes de criar outra aposta. Você pode vincular este comprovante a um
                registro existente.
              </p>
              {detail.duplicates.map((candidate) => (
                <div key={candidate.betId}>
                  <strong>{candidate.reference || 'Sem referência'}</strong> ·{' '}
                  {formatBRL(candidate.stake)} · {dateLabel(candidate.placedAt)}
                  <span>
                    {candidate.reasons.includes('image')
                      ? 'Mesma imagem'
                      : candidate.reasons.includes('reference')
                        ? 'Mesma referência'
                        : 'Valores e data semelhantes'}
                  </span>
                </div>
              ))}
              {detail.duplicateCount > 100 ? (
                <small>Há mais candidatos. Consulte a lista de apostas.</small>
              ) : null}
            </div>
          ) : null}
          <div className="review-modes" aria-label="Ação sobre a importação">
            {(['create', 'link', 'discard', 'retry'] as const)
              .filter((value) => value !== 'retry' || item.state !== 'pending')
              .map((value) => (
                <Button
                  key={value}
                  variant={mode === value ? 'default' : 'secondary'}
                  disabled={!!actions.pending}
                  onClick={() => setMode(value)}
                >
                  {
                    {
                      create: 'Registrar aposta',
                      link: 'Vincular existente',
                      discard: 'Descartar',
                      retry: 'Solicitar nova extração',
                    }[value]
                  }
                </Button>
              ))}
          </div>
          {mode === 'create' ? (
            workspace.initialized ? (
              <BetForm review={detail} workspace={workspace} onDone={onDone} />
            ) : (
              <p className="notice warning">
                Confira os saldos iniciais antes de registrar a aposta.
              </p>
            )
          ) : mode === 'link' ? (
            <CommandForm
              onDone={onDone}
              submitLabel="Vincular sem novo lançamento"
              onSubmit={() => ({
                type: 'import.confirm',
                importId: item.id,
                expectedInboxVersion: item.version,
                decision: { kind: 'link', betId: target, reason },
              })}
            >
              <ExistingBetPicker
                workspace={workspace}
                detail={detail}
                target={target}
                setTarget={setTarget}
              />
              <Field label="Motivo do vínculo">
                <textarea
                  required
                  minLength={3}
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              <label className="checkbox-field">
                <input type="checkbox" required />
                Conferi que o comprovante pertence à aposta indicada.
              </label>
            </CommandForm>
          ) : mode === 'discard' ? (
            <CommandForm
              onDone={onDone}
              submitLabel="Descartar importação"
              onSubmit={() => ({
                type: 'import.discard',
                importId: item.id,
                expectedInboxVersion: item.version,
                reason,
              })}
            >
              <Field label="Motivo do descarte">
                <textarea
                  required
                  minLength={3}
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              <p className="form-intro">
                O histórico será preservado. O arquivo poderá expirar após 30 dias, se não houver
                outra referência ativa.
              </p>
            </CommandForm>
          ) : (
            <CommandForm
              onDone={onDone}
              submitLabel="Confirmar nova extração"
              onSubmit={() => ({
                type: 'import.retry',
                importId: item.id,
                expectedInboxVersion: item.version,
              })}
            >
              <p className="notice warning">
                Uma nova extração pode consumir uma chamada paga. A solicitação ficará na fila se a
                integração não estiver ativa.
              </p>
              <label className="checkbox-field">
                <input type="checkbox" required />
                Quero solicitar outra extração e conferir o resultado.
              </label>
            </CommandForm>
          )}
        </>
      )}
    </div>
  );
}
function ExistingBetPicker({
  workspace,
  detail,
  target,
  setTarget,
}: {
  workspace: Workspace;
  detail: ImportDetail;
  target: string;
  setTarget: (id: string) => void;
}) {
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = useQuery({
    queryKey: ['product', 'linkable-bets', page, from, to, workspace.version],
    queryFn: () =>
      request(
        `/api/v1/bets?page=${page}&pageSize=25${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`,
        betPageSchema,
      ),
  });
  const options = new Map(
    detail.duplicates.map((candidate) => [
      candidate.betId,
      {
        id: candidate.betId,
        reference: candidate.reference,
        bookmakerId: candidate.bookmakerId,
        stake: candidate.stake,
        placedAt: candidate.placedAt,
        event: 'Possível duplicação',
      },
    ]),
  );
  for (const bet of query.data?.items ?? [])
    options.set(bet.id, { ...bet, event: bet.selections[0]?.event ?? 'Bilhete' });
  return (
    <>
      <div className="form-grid">
        <Field label="Apostas desde">
          <input
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setPage(1);
              setTarget('');
            }}
          />
        </Field>
        <Field label="Apostas até">
          <input
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setPage(1);
              setTarget('');
            }}
          />
        </Field>
      </div>
      <Field
        label="Aposta existente"
        hint="Confira casa, data, valor e referência antes de vincular."
      >
        <select required value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="">Selecione uma aposta</option>
          {[...options.values()].map((bet) => (
            <option key={bet.id} value={bet.id}>
              {workspace.catalog.find((item) => item.id === bet.bookmakerId)?.name ?? 'Casa'} ·{' '}
              {bet.reference || bet.event} · {dateLabel(bet.placedAt)} · {formatBRL(bet.stake)}
            </option>
          ))}
        </select>
      </Field>
      {query.isError ? <p role="alert">Não foi possível carregar as apostas.</p> : null}
      <div className="pagination">
        <span>Página {page}</span>
        <div className="button-row">
          <Button
            variant="secondary"
            size="small"
            disabled={page === 1}
            onClick={() => {
              setPage(page - 1);
              setTarget('');
            }}
          >
            Anteriores
          </Button>
          <Button
            variant="secondary"
            size="small"
            disabled={!query.data || page * 25 >= query.data.total}
            onClick={() => {
              setPage(page + 1);
              setTarget('');
            }}
          >
            Mais apostas
          </Button>
        </div>
      </div>
    </>
  );
}
export function BetAttachments({
  id,
  version,
  open,
}: {
  id: string;
  version: number;
  open: OpenModal;
}) {
  const query = useQuery({
    queryKey: ['product', 'bet-attachments', id, version],
    queryFn: () => request(`/api/v1/imports?betId=${id}&pageSize=100`, importPageSchema),
  });
  return (
    <section className="bet-attachments">
      <h3>Comprovantes</h3>
      {query.isError ? (
        <p role="alert">Não foi possível consultar os comprovantes.</p>
      ) : !query.data ? (
        <p role="status">Carregando comprovantes…</p>
      ) : query.data.items.length ? (
        <div className="button-row">
          {query.data.items.map((item, index) => (
            <Button
              key={item.id}
              variant="secondary"
              onClick={() => open({ kind: 'import', id: item.id })}
            >
              Comprovante {index + 1}
              {item.imageAvailable ? '' : ' · imagem expirada'}
            </Button>
          ))}
        </div>
      ) : (
        <p>Nenhum comprovante vinculado.</p>
      )}
      {query.data && query.data.total > 100 ? (
        <p>
          Mostrando 100 de {query.data.total} comprovantes. Consulte Importações para ver os demais.
        </p>
      ) : null}
    </section>
  );
}
