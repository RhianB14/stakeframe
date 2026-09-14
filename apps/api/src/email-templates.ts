/**
 * PT-BR transactional e-mail templates for the Stakeframe auth flows.
 *
 * - Plain, dependency-free HTML (inline styles, no scripts, no external assets, no
 *   tracking) plus an equivalent text part.
 * - The only dynamic values rendered are the action URL and fixed text; the raw token
 *   appears exclusively inside the action URL the recipient needs to click, and no
 *   template ever includes IP, user-agent or other device data.
 */

export type RenderedEmail = { subject: string; html: string; text: string };

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function render(options: {
  intro: string[];
  action: { label: string; url: string };
  notes: string[];
}): { html: string; text: string } {
  const url = escapeHtml(options.action.url);
  const html = [
    '<div style="margin:0 auto;max-width:480px;padding:24px;font-family:Helvetica,Arial,sans-serif;color:#1c1c1e;">',
    '<p style="margin:0 0 20px;font-size:15px;font-weight:600;letter-spacing:0.04em;">stakeframe<span style="color:#e0503a;">.</span></p>',
    ...options.intro.map(
      (line) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;">${line}</p>`,
    ),
    `<p style="margin:24px 0;"><a href="${url}" style="display:inline-block;padding:12px 20px;background:#1c1c1e;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px;">${escapeHtml(options.action.label)}</a></p>`,
    ...options.notes.map(
      (line) =>
        `<p style="margin:0 0 10px;font-size:13px;line-height:1.5;color:#6b6b70;">${line}</p>`,
    ),
    '</div>',
  ].join('');
  const text = [
    'stakeframe.',
    '',
    ...options.intro.map((line) => line.replace(/<[^>]+>/g, '')),
    '',
    `${options.action.label}: ${options.action.url}`,
    '',
    ...options.notes.map((line) => line.replace(/<[^>]+>/g, '')),
  ].join('\n');
  return { html, text };
}

export function verificationEmail(input: { url: string; expiresInMinutes: number }): RenderedEmail {
  const body = render({
    intro: [
      'Olá! Falta um passo para ativar seu acesso ao beta do Stakeframe: confirme seu endereço de e-mail.',
      'Clique no botão abaixo para confirmar.',
    ],
    action: { label: 'Confirmar e-mail', url: input.url },
    notes: [
      `Este link expira em ${input.expiresInMinutes} minutos e pode ser usado uma única vez.`,
      'Se você não solicitou este cadastro, ignore este e-mail. Nenhuma conta é ativada sem esta confirmação.',
    ],
  });
  return { subject: 'Confirme seu e-mail no Stakeframe', ...body };
}

export function passwordResetEmail(input: {
  url: string;
  expiresInMinutes: number;
}): RenderedEmail {
  const body = render({
    intro: [
      'Recebemos um pedido para redefinir a senha da sua conta Stakeframe.',
      'Clique no botão abaixo para escolher uma nova senha.',
    ],
    action: { label: 'Redefinir senha', url: input.url },
    notes: [
      `Este link expira em ${input.expiresInMinutes} minutos e só pode ser usado uma vez.`,
      'Se não foi você, ignore este e-mail: sua senha permanece a mesma.',
    ],
  });
  return { subject: 'Redefina sua senha do Stakeframe', ...body };
}

export function newLoginEmail(input: { when: string; appUrl: string }): RenderedEmail {
  const body = render({
    intro: [
      `Detectamos um login na sua conta Stakeframe em um novo dispositivo ou navegador, em ${input.when}.`,
      'Se foi você, pode ignorar este aviso.',
    ],
    action: { label: 'Abrir o Stakeframe', url: input.appUrl },
    notes: [
      'Se você não reconhece este acesso, redefina sua senha imediatamente pela tela de login.',
      'Por segurança, este aviso não inclui endereço IP nem dados do dispositivo.',
    ],
  });
  return { subject: 'Novo login na sua conta Stakeframe', ...body };
}
