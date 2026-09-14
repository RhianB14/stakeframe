/**
 * High-level e-mail service used by the auth flows: renders the PT-BR templates and
 * delivers them through the configured sender. Every delivery failure is normalized to
 * the sanitized `EMAIL_SEND_FAILED` error — caller responses and logs never carry
 * provider, SMTP or driver detail, and the raw token exists only inside the action URL
 * of the message that is handed to the recipient.
 */
import { EmailSendError, type EmailMeta, type EmailSender } from './email.js';
import { newLoginEmail, passwordResetEmail, verificationEmail } from './email-templates.js';

export const VERIFICATION_TOKEN_TTL_MINUTES = 60;
export const PASSWORD_RESET_TOKEN_TTL_MINUTES = 30;

export type EmailService = {
  sendVerificationEmail: (input: { to: string; url: string }) => Promise<void>;
  sendPasswordResetEmail: (input: { to: string; token: string }) => Promise<void>;
  sendNewLoginAlert: (input: { to: string; when: Date }) => Promise<void>;
};

function formatLoginTime(when: Date): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'America/Sao_Paulo',
    }).format(when);
  } catch {
    return 'horário não informado';
  }
}

export function createEmailService(options: { sender: EmailSender; origin: string }): EmailService {
  // The reset link always points at the application itself; the token never travels
  // through a provider redirect.
  const origin = options.origin.endsWith('/') ? options.origin.slice(0, -1) : options.origin;
  async function deliver(
    to: string,
    rendered: { subject: string; html: string; text: string },
    meta: EmailMeta,
  ) {
    try {
      await options.sender.send({ to, ...rendered, meta });
    } catch (error) {
      throw error instanceof EmailSendError ? error : new EmailSendError();
    }
  }
  return {
    async sendVerificationEmail({ to, url }) {
      await deliver(
        to,
        verificationEmail({ url, expiresInMinutes: VERIFICATION_TOKEN_TTL_MINUTES }),
        { kind: 'verification', url },
      );
    },
    async sendPasswordResetEmail({ to, token }) {
      const url = `${origin}/?reset=${encodeURIComponent(token)}`;
      await deliver(
        to,
        passwordResetEmail({ url, expiresInMinutes: PASSWORD_RESET_TOKEN_TTL_MINUTES }),
        { kind: 'password-reset', url },
      );
    },
    async sendNewLoginAlert({ to, when }) {
      await deliver(to, newLoginEmail({ when: formatLoginTime(when), appUrl: `${origin}/` }), {
        kind: 'new-login',
      });
    },
  };
}
