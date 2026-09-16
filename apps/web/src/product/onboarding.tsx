import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isValidTimeZone,
  onboardingStatusSchema,
  type OnboardingStatus,
  type Workspace,
} from '@stakeframe/shared';
import { request, ApiFailure } from './api.js';
import { Field, InitializeForm } from './forms.js';
import { Button } from '../components/ui/button.js';
import type { OpenModal } from './ProductApp.js';

/**
 * First steps screen (STK-F1-09).
 *
 * The server owns every rule: progress, timezone validation and completion are computed by the
 * API; this screen only guides the flow and never blocks a rule on its own. Reloading the page
 * in any step resumes from the persisted state — nothing private is kept in the browser beyond
 * the current form inputs.
 */
const COMMON_TIME_ZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Belem',
  'America/Fortaleza',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Paris',
  'UTC',
];

function message(error: unknown, fallback: string) {
  return error instanceof ApiFailure ? error.message : fallback;
}

export function OnboardingPage({ workspace, open }: { workspace: Workspace; open: OpenModal }) {
  const status = useQuery({
    queryKey: ['product', 'onboarding'],
    queryFn: () => request('/api/v1/onboarding', onboardingStatusSchema),
    refetchInterval: 30_000,
  });
  if (status.isPending)
    return (
      <div className="panel">
        <div className="section-heading">
          <div>
            <h2>Primeiros passos</h2>
            <p>Preparando seu fluxo de entrada</p>
          </div>
        </div>
        <p role="status" className="form-intro">
          Carregando seus primeiros passos…
        </p>
      </div>
    );
  if (status.isError || !status.data)
    return (
      <div className="panel">
        <div className="section-heading">
          <div>
            <h2>Primeiros passos</h2>
            <p>Preparando seu fluxo de entrada</p>
          </div>
        </div>
        <p role="alert" className="notice warning">
          Não foi possível carregar seu progresso.
        </p>
        <div className="onboarding-actions">
          <Button
            onClick={() => {
              void status.refetch();
            }}
          >
            Tentar novamente
          </Button>
        </div>
      </div>
    );
  return <OnboardingFlow workspace={workspace} open={open} status={status.data} />;
}

function OnboardingFlow({
  workspace,
  open,
  status,
}: {
  workspace: Workspace;
  open: OpenModal;
  status: OnboardingStatus;
}) {
  const step = !status.steps.profile.completed
    ? 1
    : !status.steps.bankroll.completed
      ? 2
      : !status.completedAt
        ? 3
        : 4;
  const stepTitles = ['Perfil', 'Primeira banca', 'Primeira aposta'];
  return (
    <div className="panel onboarding-panel">
      <div className="section-heading">
        <div>
          <h2>Primeiros passos</h2>
          <p>Três etapas curtas para começar a acompanhar seus resultados</p>
        </div>
        <span className="onboarding-progress" role="status">
          {step <= 3 ? `Passo ${step} de 3` : 'Concluído'}
        </span>
      </div>
      <ol className="onboarding-steps" aria-label="Etapas dos primeiros passos">
        {stepTitles.map((title, index) => {
          const number = index + 1;
          const done =
            number === 1
              ? status.steps.profile.completed
              : number === 2
                ? status.steps.bankroll.completed
                : status.steps.firstBet.completed || status.completedAt !== null;
          return (
            <li
              key={title}
              className={`onboarding-step ${number === step ? 'active' : ''} ${done ? 'done' : ''}`}
              aria-current={number === step ? 'step' : undefined}
            >
              <span className="onboarding-step-number" aria-hidden="true">
                {done ? '✓' : number}
              </span>
              {title}
            </li>
          );
        })}
      </ol>
      {step === 1 ? <ProfileStep status={status} /> : null}
      {step === 2 ? <BankrollStep status={status} workspace={workspace} open={open} /> : null}
      {step === 3 ? <FirstBetStep status={status} open={open} /> : null}
    </div>
  );
}

function ProfileStep({ status }: { status: OnboardingStatus }) {
  const client = useQueryClient();
  const [displayName, setDisplayName] = useState(status.displayName);
  const [timezone, setTimezone] = useState(
    status.timezone ??
      (typeof Intl !== 'undefined'
        ? (Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'America/Sao_Paulo')
        : 'America/Sao_Paulo'),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const name = displayName.trim();
    if (name.length === 0) {
      setError('Informe o nome que deve aparecer na sua conta.');
      return;
    }
    const zone = timezone.trim();
    if (!isValidTimeZone(zone)) {
      setError('Informe um fuso horário IANA válido, como America/Sao_Paulo.');
      return;
    }
    setSaving(true);
    try {
      await request('/api/v1/onboarding', onboardingStatusSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step: 'profile', displayName: name, timezone: zone }),
      });
      await client.invalidateQueries({ queryKey: ['product'] });
      await client.invalidateQueries({ queryKey: ['owner-session'] });
    } catch (reason) {
      setError(message(reason, 'Não foi possível salvar seu perfil. Tente novamente.'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section aria-labelledby="onboarding-profile-title" className="onboarding-section">
      <h3 id="onboarding-profile-title">Seu perfil</h3>
      <p className="form-intro">
        Confirme como quer ser chamado e o fuso horário usado nas datas do seu registro.
      </p>
      <form
        className="product-form"
        aria-busy={saving}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <fieldset disabled={saving}>
          <div className="form-grid">
            <Field label="Nome exibido">
              <input
                required
                maxLength={120}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </Field>
            <Field label="Fuso horário" hint="Formato IANA, como America/Sao_Paulo.">
              <input
                required
                list="onboarding-timezones"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              />
            </Field>
            <datalist id="onboarding-timezones">
              {COMMON_TIME_ZONES.map((zone) => (
                <option value={zone} key={zone} />
              ))}
            </datalist>
          </div>
        </fieldset>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="form-actions">
          <Button type="submit" disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar e continuar'}
          </Button>
        </div>
      </form>
    </section>
  );
}

function BankrollStep({
  status,
  workspace,
  open,
}: {
  status: OnboardingStatus;
  workspace: Workspace;
  open: OpenModal;
}) {
  const houses = workspace.catalog.filter((item) => item.kind === 'bookmaker' && item.active);
  const client = useQueryClient();
  return (
    <section aria-labelledby="onboarding-bankroll-title" className="onboarding-section">
      <h3 id="onboarding-bankroll-title">Sua primeira banca</h3>
      {status.steps.bankroll.completed ? (
        <p className="notice" role="status">
          Sua banca inicial já está configurada.
        </p>
      ) : houses.length === 0 ? (
        <>
          <p className="form-intro">
            Comece indicando a casa onde você aposta e o saldo disponível nela.
          </p>
          <div className="onboarding-actions">
            <Button onClick={() => open({ kind: 'catalog', catalogKind: 'bookmaker' })}>
              Adicionar casa
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="form-intro">
            Informe a reserva e o saldo disponível em cada casa. A unidade deste mês será calculada
            sobre essa banca inicial — nada é registrado antes da sua confirmação.
          </p>
          <InitializeForm
            workspace={workspace}
            onDone={() => {
              void client.invalidateQueries({ queryKey: ['product'] });
            }}
          />
        </>
      )}
    </section>
  );
}

function FirstBetStep({ status, open }: { status: OnboardingStatus; open: OpenModal }) {
  const client = useQueryClient();
  const [showTelegram, setShowTelegram] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolution = status.steps.firstBet.resolution;
  async function finish(firstBet: 'registered' | 'deferred') {
    setSaving(true);
    setError(null);
    try {
      await request('/api/v1/onboarding', onboardingStatusSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step: 'finish', firstBet }),
      });
      await client.invalidateQueries({ queryKey: ['product'] });
    } catch (reason) {
      setError(message(reason, 'Não foi possível concluir os primeiros passos. Tente novamente.'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section aria-labelledby="onboarding-first-bet-title" className="onboarding-section">
      <h3 id="onboarding-first-bet-title">Sua primeira aposta</h3>
      {resolution === 'registered' ? (
        <p className="notice" role="status">
          Primeira aposta registrada — você já pode acompanhá-la em Apostas.
        </p>
      ) : resolution === 'deferred' ? (
        <p className="notice" role="status">
          Você escolheu continuar sem registrar agora. Conecte o Telegram quando quiser — nada se
          perde.
        </p>
      ) : (
        <p className="form-intro">
          Registre uma aposta manualmente agora ou prepare a conexão com o Telegram. Se preferir,
          você pode seguir sem registrar uma aposta agora — a escolha fica registrada.
        </p>
      )}
      <div className="onboarding-actions">
        <Button onClick={() => open({ kind: 'bet' })}>Registrar aposta manual</Button>
        <Button variant="secondary" onClick={() => setShowTelegram(true)}>
          Conectar Telegram
        </Button>
      </div>
      {showTelegram ? (
        <p className="notice" role="status">
          A vinculação do Telegram pelo site faz parte do pacote do beta (STK-F2-04) e será
          habilitada em uma próxima etapa. Você pode registrar sua primeira aposta manualmente agora
          e conectar depois, sem perder nada.
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <Button
          variant="ghost"
          onClick={() => void finish(resolution ?? 'deferred')}
          disabled={saving}
        >
          {saving
            ? 'Concluindo…'
            : resolution
              ? 'Concluir primeiros passos'
              : 'Continuar sem registrar aposta'}
        </Button>
      </div>
    </section>
  );
}
