import { describe, expect, it, vi } from 'vitest';
import {
  EmailSendError,
  createMemoryEmailSender,
  createResendEmailSender,
  readEmailRuntimeConfig,
} from '../../apps/api/src/email.js';
import { createEmailService } from '../../apps/api/src/email-service.js';

const origin = 'https://app.stakeframe.test';

function serviceWith(sender: Parameters<typeof createEmailService>[0]['sender']) {
  return createEmailService({ sender, origin });
}

describe('e-mail templates and service', () => {
  it('renders the verification mail with the action link, brand and explicit expiry', async () => {
    const memory = createMemoryEmailSender();
    const service = serviceWith(memory.sender);
    const url = `${origin}/api/auth/verify-email?token=FIXTURE&callbackURL=%2F`;
    await service.sendVerificationEmail({ to: 'person@example.test', url });
    const message = memory.takeLast()!;
    expect(message.to).toBe('person@example.test');
    expect(message.subject).toBe('Confirme seu e-mail no Stakeframe');
    expect(message.meta).toEqual({ kind: 'verification', url });
    expect(message.html).toContain('stakeframe');
    expect(message.html).toContain('Confirmar e-mail');
    expect(message.html).toContain('token=FIXTURE');
    expect(message.html).toContain('60 minutos');
    expect(message.text).toContain(url);
  });
  it('builds the password-reset link against the app origin with a short expiry', async () => {
    const memory = createMemoryEmailSender();
    const service = serviceWith(memory.sender);
    await service.sendPasswordResetEmail({ to: 'person@example.test', token: 'tok 123' });
    const message = memory.takeLast()!;
    expect(message.subject).toBe('Redefina sua senha do Stakeframe');
    expect(message.meta.kind).toBe('password-reset');
    expect(message.meta.url).toBe(`${origin}/?reset=tok%20123`);
    expect(message.html).toContain('/?reset=tok%20123');
    expect(message.html).toContain('30 minutos');
    expect(message.html).toContain('Redefinir senha');
  });
  it('sends the new-login alert without IP or device data', async () => {
    const memory = createMemoryEmailSender();
    const service = serviceWith(memory.sender);
    const when = new Date('2026-09-13T23:30:00.000Z');
    await service.sendNewLoginAlert({ to: 'person@example.test', when });
    const message = memory.takeLast()!;
    expect(message.subject).toBe('Novo login na sua conta Stakeframe');
    expect(message.meta.kind).toBe('new-login');
    expect(message.text).toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(message.html).not.toMatch(/192\.0\.2|Mozilla|user-agent/i);
    expect(message.text).not.toMatch(/192\.0\.2|Mozilla|user-agent/i);
    expect(message.text).toContain('novo dispositivo');
  });
  it('normalizes any sender failure into the sanitized EMAIL_SEND_FAILED error', async () => {
    const failing = serviceWith({
      kind: 'memory',
      send: async () => {
        throw new Error('raw provider detail');
      },
    });
    await expect(failing.sendNewLoginAlert({ to: 'a@b.test', when: new Date() })).rejects.toThrow(
      EmailSendError,
    );
    await expect(
      failing.sendPasswordResetEmail({ to: 'a@b.test', token: 't' }),
    ).rejects.toMatchObject({ message: 'EMAIL_SEND_FAILED' });
  });
  it('captures messages by kind and clears them', async () => {
    const memory = createMemoryEmailSender();
    expect(memory.takeLast()).toBeUndefined();
    await memory.sender.send({
      to: 'a@b.test',
      subject: 's',
      html: 'h',
      text: 't',
      meta: { kind: 'new-login' },
    });
    expect(memory.takeAll('verification')).toHaveLength(0);
    expect(memory.takeAll('new-login')).toHaveLength(1);
    memory.clear();
    expect(memory.messages).toHaveLength(0);
  });
});

describe('resend e-mail sender', () => {
  it('posts the message to the Resend API with the configured secret in the header', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const sender = createResendEmailSender({
      apiKey: 'test-only-key',
      from: 'Stakeframe <no-reply@stakeframe.test>',
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return Response.json({ id: 'fixture' });
      }) as typeof fetch,
    });
    await sender.send({
      to: 'person@example.test',
      subject: 'Assunto',
      html: '<p>oi</p>',
      text: 'oi',
      meta: { kind: 'verification' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-only-key');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      from: 'Stakeframe <no-reply@stakeframe.test>',
      to: ['person@example.test'],
      subject: 'Assunto',
      html: '<p>oi</p>',
      text: 'oi',
    });
    // The message metadata used by tests/local inspection never reaches the provider.
    expect(JSON.stringify(body)).not.toContain('meta');
  });
  it('collapses provider and network failures without echoing any detail', async () => {
    const failing = createResendEmailSender({
      apiKey: 'test-only-key',
      from: 'Stakeframe <no-reply@stakeframe.test>',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: 'bad api key sk_live_leak' }), {
          status: 500,
        })) as typeof fetch,
    });
    const message = {
      to: 'person@example.test',
      subject: 's',
      html: 'h',
      text: 't',
      meta: { kind: 'verification' as const },
    };
    await expect(failing.send(message)).rejects.toMatchObject({ message: 'EMAIL_SEND_FAILED' });
    await failing.send(message).catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain('sk_live_leak');
      expect(String(error)).not.toContain('bad api key');
    });
    const network = createResendEmailSender({
      apiKey: 'test-only-key',
      from: 'Stakeframe <no-reply@stakeframe.test>',
      fetchImpl: (async () => {
        throw new TypeError('getaddrinfo ENOTFOUND api.resend.com');
      }) as typeof fetch,
    });
    await network.send(message).catch((error: unknown) => {
      expect(String(error)).not.toContain('ENOTFOUND');
      expect(String(error)).toContain('EMAIL_SEND_FAILED');
    });
  });
});

describe('email runtime configuration', () => {
  const read = (runtime: 'local' | 'production', environment: Record<string, string | undefined>) =>
    readEmailRuntimeConfig(runtime, environment as NodeJS.ProcessEnv);
  it('defaults to the in-memory adapter outside production and to unavailable in production', () => {
    expect(read('local', {})).toEqual({ kind: 'memory' });
    expect(read('production', {})).toBeNull();
  });
  it('uses Resend when the key and sender are configured', () => {
    const result = read('production', {
      RESEND_API_KEY: 'test-only-key',
      RESEND_FROM: 'Stakeframe <no-reply@stakeframe.test>',
    });
    expect(result).toEqual({
      kind: 'resend',
      apiKey: 'test-only-key',
      from: 'Stakeframe <no-reply@stakeframe.test>',
    });
  });
  it('never falls back to memory in production and rejects misconfiguration', () => {
    expect(read('production', { EMAIL_TRANSPORT: 'memory' })).toBeNull();
    expect(read('local', { EMAIL_TRANSPORT: 'resend' })).toBeNull();
    expect(read('local', { EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'k' })).toBeNull();
    expect(read('local', { RESEND_API_KEY: 'k', RESEND_FROM: 'not-an-email' })).toBeNull();
    expect(read('local', { RESEND_API_KEY: 'key-without-sender' })).toBeNull();
  });
  it('does not log or expose secrets while reading configuration', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = read('local', { RESEND_API_KEY: 'sk_live_never_logged' });
      expect(result).toBeNull();
      for (const call of spy.mock.calls)
        expect(JSON.stringify(call)).not.toContain('sk_live_never_logged');
    } finally {
      spy.mockRestore();
    }
  });
});
