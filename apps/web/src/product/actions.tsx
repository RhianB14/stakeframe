import { createContext, useContext, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { financeCommandSchema, type FinanceCommand } from '@stakeframe/shared';
import { ApiFailure, sendCommand, type CommandInput } from './api.js';
import { Button } from '../components/ui/button.js';

const storageKey = 'stakeframe.pending-command';
type Pending = { owner: string; key: string; command: FinanceCommand };
function readPending(owner: string): Pending | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (
      value &&
      typeof value === 'object' &&
      'owner' in value &&
      value.owner === owner &&
      'key' in value &&
      typeof value.key === 'string' &&
      /^[a-f0-9-]{36}$/i.test(value.key) &&
      'command' in value
    ) {
      const command = financeCommandSchema.safeParse(value.command);
      if (command.success) return { owner, key: value.key, command: command.data };
    }
  } catch {
    /* No private content is rendered from invalid storage. */
  }
  return null;
}
function useActions(owner: string, version: number) {
  const client = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(() => readPending(owner));
  const pendingRef = useRef(pending);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  async function perform(operation: Pending) {
    if (busyRef.current) throw new Error('Aguarde a operação atual.');
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await sendCommand(operation.command, operation.key);
      sessionStorage.removeItem(storageKey);
      pendingRef.current = null;
      setPending(null);
      await client.invalidateQueries({ queryKey: ['product'] });
      return result;
    } catch (reason) {
      if (
        reason instanceof ApiFailure &&
        reason.status >= 400 &&
        reason.status < 500 &&
        ![401, 403, 408, 429].includes(reason.status)
      ) {
        sessionStorage.removeItem(storageKey);
        pendingRef.current = null;
        setPending(null);
        await client.invalidateQueries({ queryKey: ['product'] });
      }
      const message =
        reason instanceof ApiFailure
          ? reason.message
          : 'Não foi possível confirmar a operação. Use Verificar operação para continuar.';
      setError(message);
      throw new Error(message, { cause: reason });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return {
    pending,
    busy,
    error,
    version,
    clearError: () => setError(null),
    async execute(input: CommandInput, expectedVersion = version) {
      if (pendingRef.current) throw new Error('Verifique a operação anterior antes de continuar.');
      const checked = financeCommandSchema.safeParse({ ...input, expectedVersion });
      if (!checked.success)
        throw new Error('Confira os campos informados. Valores usam até duas casas decimais.');
      const operation = { owner, key: crypto.randomUUID(), command: checked.data };
      // Keep the same operation across network failures, closed dialogs and page reloads.
      sessionStorage.setItem(storageKey, JSON.stringify(operation));
      pendingRef.current = operation;
      setPending(operation);
      return perform(operation);
    },
    async recover() {
      if (!pendingRef.current) throw new Error('Nenhuma operação pendente.');
      return perform(pendingRef.current);
    },
  };
}
type Actions = ReturnType<typeof useActions>;
const context = createContext<Actions | null>(null);
export function ActionProvider({
  owner,
  version,
  children,
}: {
  owner: string;
  version: number;
  children: ReactNode;
}) {
  const value = useActions(owner, version);
  return <context.Provider value={value}>{children}</context.Provider>;
}
export function useFinanceActions() {
  const value = useContext(context);
  if (!value) throw new Error('ACTION_CONTEXT_REQUIRED');
  return value;
}
export function PendingOperation() {
  const actions = useFinanceActions();
  return actions.pending && !actions.busy ? (
    <div className="notice warning" role="alert">
      <div>
        <strong>Uma operação aguarda confirmação.</strong>
        <p>
          Confira o resultado antes de fazer outro lançamento. A verificação preserva a
          identificação original.
        </p>
        {actions.error ? <p>{actions.error}</p> : null}
      </div>
      <Button
        onClick={() => {
          void actions.recover().catch(() => undefined);
        }}
      >
        Verificar operação
      </Button>
    </div>
  ) : null;
}
export function CommandForm({
  children,
  onSubmit,
  onDone,
  submitLabel = 'Salvar',
}: {
  children: ReactNode;
  onSubmit: () => CommandInput;
  onDone: () => void;
  submitLabel?: string;
}) {
  const actions = useFinanceActions();
  const [validation, setValidation] = useState<string | null>(null);
  const [versionAtOpen] = useState(actions.version);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setValidation(null);
    try {
      await actions.execute(onSubmit(), versionAtOpen);
      onDone();
    } catch (error) {
      setValidation(error instanceof Error ? error.message : 'Confira os dados.');
    }
  };
  return (
    <form
      className="product-form"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <fieldset disabled={actions.busy || !!actions.pending}>{children}</fieldset>
      {validation || actions.error ? (
        <p className="form-error" role="alert">
          {validation ?? actions.error}
        </p>
      ) : null}
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          Fechar
        </Button>
        {actions.pending && !actions.busy ? (
          <Button
            onClick={() => {
              void actions
                .recover()
                .then(onDone)
                .catch(() => undefined);
            }}
          >
            Verificar operação
          </Button>
        ) : (
          <Button type="submit" disabled={actions.busy}>
            {actions.busy ? 'Salvando…' : submitLabel}
          </Button>
        )}
      </div>
    </form>
  );
}
