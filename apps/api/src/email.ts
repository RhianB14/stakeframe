/**
 * E-mail delivery abstraction for the Stakeframe auth flows.
 *
 * - `createResendEmailSender`: real delivery through the Resend HTTP API (no SDK),
 *   configured exclusively through environment secrets — never hardcoded, never logged.
 *   Failures are collapsed into a single sanitized `EMAIL_SEND_FAILED` error: provider
 *   response bodies, keys and network details never propagate.
 * - `createMemoryEmailSender`: fake/in-memory adapter used by local runtime and tests; it
 *   never sends real mail and never touches external services.
 */
import { readSecret } from '@stakeframe/db';

export const EMAIL_SEND_FAILED = 'EMAIL_SEND_FAILED';

export class EmailSendError extends Error {
  constructor() {
    super(EMAIL_SEND_FAILED);
    this.name = 'EmailSendError';
  }
}

export type EmailMeta = {
  kind: 'verification' | 'password-reset' | 'new-login';
  /** Action URL for test/local inspection; never sent through the provider payload. */
  url?: string;
};

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  meta: EmailMeta;
};

export type EmailSender = {
  kind: 'resend' | 'memory';
  send: (message: EmailMessage) => Promise<void>;
};

export type MemoryEmailSender = {
  sender: EmailSender;
  /** In-memory capture for tests/local inspection; never persisted or logged. */
  messages: EmailMessage[];
  takeLast: () => EmailMessage | undefined;
  takeAll: (kind?: EmailMeta['kind']) => EmailMessage[];
  clear: () => void;
};

export function createMemoryEmailSender(): MemoryEmailSender {
  const messages: EmailMessage[] = [];
  return {
    sender: {
      kind: 'memory',
      send: async (message) => {
        messages.push(message);
      },
    },
    messages,
    takeLast: () => messages[messages.length - 1],
    takeAll: (kind) =>
      kind ? messages.filter((message) => message.meta.kind === kind) : [...messages],
    clear: () => {
      messages.length = 0;
    },
  };
}

export function createResendEmailSender(options: {
  apiKey: string;
  from: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}): EmailSender {
  const endpoint = options.endpoint ?? 'https://api.resend.com/emails';
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    kind: 'resend',
    async send(message) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: options.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        // Network/timeout failures: sanitized, no underlying detail escapes.
        throw new EmailSendError();
      }
      if (!response.ok) {
        // Provider errors: status body is never echoed; only the stable code leaves.
        throw new EmailSendError();
      }
    },
  };
}

export type EmailRuntimeConfig =
  { kind: 'resend'; apiKey: string; from: string } | { kind: 'memory' };

/** Accepts `address@domain` or `Display Name <address@domain>`; rejects header injection. */
function isValidSender(value: string | undefined): value is string {
  if (!value || value.length > 200 || /[\r\n]/.test(value)) return false;
  const match = /<([^<>]+)>$/.exec(value.trim());
  const address = (match ? match[1]! : value).trim();
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]{2,}$/.test(address);
}

/**
 * Resolves how the runtime should deliver e-mail.
 *
 * - `EMAIL_TRANSPORT=resend` requires `RESEND_API_KEY(_FILE)` and `RESEND_FROM`; without
 *   them the runtime stays without a sender (password flows respond 503, sanitized) —
 *   e-mail verification is never weakened to compensate.
 * - `EMAIL_TRANSPORT=memory` is only honored outside production.
 * - With no explicit transport: local = memory; production = Resend when configured.
 */
export function readEmailRuntimeConfig(
  runtime: 'local' | 'production',
  environment: NodeJS.ProcessEnv,
): EmailRuntimeConfig | null {
  const transport = environment.EMAIL_TRANSPORT?.trim().toLowerCase();
  // The API key is optional: only read the secret when it is actually configured, so a
  // production boot without Resend never fails (`readSecret` enforces file-only secrets
  // for production and throws when the variable is absent).
  const configuredKey =
    environment.RESEND_API_KEY !== undefined || environment.RESEND_API_KEY_FILE !== undefined;
  const apiKey = configuredKey ? readSecret(environment, 'RESEND_API_KEY') : undefined;
  const from = environment.RESEND_FROM?.trim();
  const validFrom = isValidSender(from);
  if (transport === 'memory') return runtime === 'production' ? null : { kind: 'memory' };
  // Any Resend configuration (key, sender or explicit transport) signals intent: partial
  // or invalid configuration stays without a sender instead of silently downgrading —
  // the sanitized 503 is safer than dropping mail.
  const configured = apiKey !== undefined || from !== undefined || transport === 'resend';
  if (!configured) return runtime === 'production' ? null : { kind: 'memory' };
  if (apiKey && validFrom) return { kind: 'resend', apiKey, from: from as string };
  return null;
}
