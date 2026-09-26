// STK-F1-10 — Plano Master §4.6 (observabilidade sanitizada), §6.1 e §12.1.
//
// Nenhum token, prompt, imagem, bilhete, conteúdo financeiro ou identificador
// externo deixa o processo cru. Sentry (beforeSend), PostHog (properties) e
// Better Stack (payload) passam todos por este scrubber compartilhado.
//
// Fail-closed: campos com chave suspeita são substituídos por [REDACTED] — o
// valor nunca é omitido silenciosamente nem enviado parcialmente.

export const TELEMETRY_REDACTED = '[REDACTED]';

const MAX_DEPTH = 6;
const MAX_ITEMS = 50;
const MAX_STRING = 2048;

// Chaves cujo conteúdo nunca sai, independentemente do formato do valor.
const SENSITIVE_KEY =
  /pass(word|wd)?|secret|token|authoriz|credential|cookie|session|jwt|bearer|api[-_]?key|private[-_]?key|dsn|prompt|telegram|chat[-_]?id|image|photo|screenshot|attachment|email|phone|telefone|cpf|cnpj|card[-_]?number|cardno|cvv|iban|pix[-_]?key/i;

// Padrões de conteúdo: tokens com prefixo conhecido, JWT, Bearer, segredos em
// query string, imagens inline, e-mails e sequências numéricas longas
// (identificadores externos, telefone/Telegram e valores financeiros).
const STRING_PATTERNS: readonly [RegExp, string][] = [
  [/Bearer\s+[\w.~+/=-]{8,}/gi, `Bearer ${TELEMETRY_REDACTED}`],
  [
    /\b(?:sk|rk|pk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abposr]|AKIA|ASIA|AIza)[-_][\w-]{10,}/g,
    TELEMETRY_REDACTED,
  ],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}\b/g, TELEMETRY_REDACTED],
  [
    /([?&](?:token|key|secret|password|passwd|code|apikey|api_key)=)[^&\s]+/gi,
    `$1${TELEMETRY_REDACTED}`,
  ],
  // Credenciais embutidas em URL de conexão (postgres://user:senha@host).
  [/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@/\s]+@/gi, `$1${TELEMETRY_REDACTED}@`],
  [/data:image\/[\w+.-]+;base64,[\w+/=]{16,}/gi, TELEMETRY_REDACTED],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, TELEMETRY_REDACTED],
  [/\b\d{11,13}\b/g, TELEMETRY_REDACTED],
];

/** Sanitiza uma string: aplica os padrões de conteúdo e limita o tamanho. */
export function scrubText(text: string): string {
  let output = text.length > MAX_STRING ? text.slice(0, MAX_STRING) : text;
  for (const [pattern, replacement] of STRING_PATTERNS)
    output = output.replace(pattern, replacement);
  return output;
}

/**
 * Sanitiza um valor arbitrário (objeto, array ou primitivo) de forma
 * recursiva: chaves sensíveis viram [REDACTED], strings passam pelos padrões
 * de conteúdo. Aplicado a eventos do Sentry, propriedades do PostHog e
 * payloads do Better Stack antes de qualquer envio.
 */
export function scrubTelemetry(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return TELEMETRY_REDACTED;
  switch (typeof value) {
    case 'string':
      return scrubText(value);
    case 'number':
      // Inteiros longos (>= 10^10): identificadores externos (Telegram),
      // telefones e valores financeiros em centavos nunca saem como número.
      return Number.isInteger(value) && Math.abs(value) >= 10_000_000_000
        ? TELEMETRY_REDACTED
        : value;
    case 'boolean':
    case 'undefined':
      return value;
    default:
      break;
  }
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => scrubTelemetry(item, depth + 1));
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY.test(key) ? TELEMETRY_REDACTED : scrubTelemetry(item, depth + 1);
    }
    return output;
  }
  // Função, símbolo ou bigint: não serializável em telemetria — descartado.
  return undefined;
}

/** Sanitiza uma linha de log: padrões + colapso de espaços + limite. */
export function sanitizeLogText(text: string): string {
  return scrubText(text).replace(/\s+/g, ' ').trim().slice(0, 1024);
}
