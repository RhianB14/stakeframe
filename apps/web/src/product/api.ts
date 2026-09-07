import {
  apiErrorSchema,
  financeCommandSchema,
  commandResultSchema,
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
