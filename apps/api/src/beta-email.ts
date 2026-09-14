/**
 * Controlled, fake and sanitized e-mail transport for the beta e-mail/password flow.
 *
 * - Used by local runtime and tests only; it never sends real e-mail and never touches
 *   external services or Resend credentials.
 * - The verification message (which carries the one-time link) is kept only in process
 *   memory, at the strictly necessary boundary, and is never logged.
 */
export type BetaVerificationEmail = {
  to: string;
  url: string;
  token: string;
};

export type BetaEmailTransport = {
  sendVerificationEmail: (message: BetaVerificationEmail) => Promise<void> | void;
};

export type MemoryEmailTransport = {
  transport: BetaEmailTransport;
  /** In-memory capture for tests/local inspection; never persisted or logged. */
  messages: BetaVerificationEmail[];
  takeLast: () => BetaVerificationEmail | undefined;
};

export function createMemoryEmailTransport(): MemoryEmailTransport {
  const messages: BetaVerificationEmail[] = [];
  return {
    transport: {
      sendVerificationEmail: (message) => {
        messages.push(message);
      },
    },
    messages,
    takeLast: () => messages[messages.length - 1],
  };
}
