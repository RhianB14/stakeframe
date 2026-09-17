import {
  apiErrorSchema,
  financeCommandSchema,
  commandResultSchema,
  importStatusResultSchema,
  cents,
  money,
  saoPauloDate,
  type FinanceCommand,
} from '@stakeframe/shared';

export type CommandInput = FinanceCommand extends infer C
  ? C extends FinanceCommand
    ? Omit<C, 'expectedVersion'>
    : never
  : never;
export class ApiFailure extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  url: string,
  schema: { parse: (value: unknown) => T },
  init: RequestInit = {},
) {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(20_000),
      ...init,
    });
  } catch {
    throw new ApiFailure(
      'Não foi possível confirmar o resultado. Verifique a operação antes de continuar.',
      0,
      'NETWORK_ERROR',
    );
  }
  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new Event('stakeframe:session-expired'));
    }
    let error;
    try {
      error = apiErrorSchema.safeParse(await response.json());
    } catch {
      error = null;
    }
    throw new ApiFailure(
      error?.success ? error.data.error.message : 'Não foi possível concluir a operação.',
      response.status,
      error?.success ? error.data.error.code : 'UNKNOWN',
    );
  }
  return schema.parse(await response.json());
}
type DraftResult = {
  version: number;
  freebetCleared: boolean;
  automaticPolicy: 'disabled' | 'absent' | 'invalid' | 'approved';
};
const draftResultSchema = {
  parse: (value: unknown): DraftResult => {
    const result = value as {
      version?: unknown;
      freebetCleared?: unknown;
      automaticPolicy?: unknown;
    } | null;
    const version = result?.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
      throw new Error('Resposta inválida do servidor.');
    const policy = result?.automaticPolicy;
    return {
      version,
      freebetCleared: result?.freebetCleared === true,
      automaticPolicy:
        policy === 'approved' || policy === 'absent' || policy === 'invalid'
          ? policy
          : ('disabled' as const),
    };
  },
};
// STK-G0-19-R5 — edição canônica do rascunho (web com sessão; Mini App com o
// initData validado no servidor). A web nunca chama o Telegram diretamente.
export function patchImportDraft(
  id: string,
  body: {
    version: number;
    betOrigin?: 'real' | 'freebet' | null;
    freebetId?: string | null;
    eventAt?: string | null;
    bookmakerId?: string | null;
  },
  initData?: string,
) {
  return request(`/api/v1/imports/${id}`, draftResultSchema, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(initData ? { 'x-telegram-init-data': initData } : {}),
    },
    body: JSON.stringify(body),
  });
}
// STK-G0-19-R7 — liquidação real pelo Mini App (seção "Alterar Status"):
// vitória/derrota de aposta pendente pelo comando canônico no servidor.
export function setImportStatus(
  id: string,
  body: { version: number; action: 'win' | 'loss' },
  initData?: string,
) {
  return request(`/api/v1/imports/${id}/status`, importStatusResultSchema, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(initData ? { 'x-telegram-init-data': initData } : {}),
    },
    body: JSON.stringify(body),
  });
}
export function sendCommand(command: FinanceCommand, key: string) {
  return request('/api/v1/commands', commandResultSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(financeCommandSchema.parse(command)),
  });
}
export function decimalInput(value: string) {
  const clean = value.trim().replace(/^R\$\s*/, '');
  return money(cents(clean.includes(',') ? clean.replaceAll('.', '').replace(',', '.') : clean));
}
export function localNow() {
  const date = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return `${saoPauloDate(date)}T${parts}`;
}
export function localInstant(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value))
    throw new Error('Informe uma data e hora válidas.');
  const matches = ['-03:00', '-02:00']
    .map((offset) => new Date(`${value}${value.length === 16 ? ':00' : ''}${offset}`))
    .filter((date) => {
      if (!Number.isFinite(date.getTime()) || saoPauloDate(date) !== value.slice(0, 10))
        return false;
      const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
        ...(value.length === 19 ? { second: '2-digit' as const } : {}),
        hourCycle: 'h23',
      }).format(date);
      return time === value.slice(11);
    });
  if (matches.length !== 1)
    throw new Error(
      'Este horário é ambíguo ou não existiu na mudança de fuso. Confira o horário original.',
    );
  return matches[0]!.toISOString();
}
export const dateLabel = (value: string) =>
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
