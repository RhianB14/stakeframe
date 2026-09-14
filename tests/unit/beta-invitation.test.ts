import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BetaInvitationError,
  createBetaInvitation,
  normalizeInvitationEmail,
  type Database,
} from '../../packages/db/src/index.js';

function unusedDatabase(counter: { connects: number; selects: number }): Database {
  return {
    orm: {
      select: () => {
        counter.selects += 1;
        throw new Error('orm.select must not run');
      },
    },
    pool: {
      connect: async () => {
        counter.connects += 1;
        throw new Error('pool.connect must not run');
      },
    },
  } as unknown as Database;
}

function insertCapturingDatabase(
  capture: { values?: Record<string, unknown> },
  outcome: () => { id: string; email: string; expiresAt: Date }[],
): Database {
  return {
    orm: {
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            capture.values = values;
            return outcome();
          },
        }),
      }),
    },
    pool: {
      connect: async () => {
        throw new Error('pool.connect must not run');
      },
    },
  } as unknown as Database;
}

describe('beta invitation e-mail normalization', () => {
  it('trims and lowercases the e-mail', () => {
    expect(normalizeInvitationEmail('  Beta.Invite@Example.TEST  ')).toBe(
      'beta.invite@example.test',
    );
    expect(normalizeInvitationEmail('BETA.INVITE@EXAMPLE.TEST')).toBe('beta.invite@example.test');
    // The whole input is trimmed before validation, so a trailing space is not an error.
    expect(normalizeInvitationEmail('trailing@example.test ')).toBe('trailing@example.test');
  });

  it('is idempotent for an already-normalized e-mail', () => {
    const once = normalizeInvitationEmail(' Person@Example.test ');
    expect(normalizeInvitationEmail(once)).toBe(once);
  });

  it('rejects invalid formats with a stable sanitized error', () => {
    const inputs = [
      '',
      '   ',
      'no-at-sign',
      'no@dot',
      'no@dot.',
      'two@@signs.test',
      'with space@example.test',
      'a'.repeat(250) + '@example.test',
    ];
    for (const input of inputs) {
      let failure: unknown = null;
      try {
        normalizeInvitationEmail(input);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(BetaInvitationError);
      expect((failure as BetaInvitationError).code).toBe('INVITATION_EMAIL_INVALID');
      expect((failure as Error).message).toBe('INVITATION_EMAIL_INVALID');
      expect(String(failure)).not.toMatch(/#|@example|sk-|postgres|relation/i);
    }
  });

  it('rejects non-string input without leaking it', () => {
    for (const value of [null, 42, {}, ['a@b.test']]) {
      expect(() => normalizeInvitationEmail(value as unknown as string)).toThrowError(
        BetaInvitationError,
      );
    }
  });
});

describe('createBetaInvitation (unit)', () => {
  it('persists only the token hash and returns the raw token to the caller', async () => {
    const capture: { values?: Record<string, unknown> } = {};
    const service = createBetaInvitation(
      insertCapturingDatabase(capture, () => [
        {
          id: 'inv-1',
          email: 'beta.invite@example.test',
          expiresAt: new Date('2099-01-01T00:00:00Z'),
        },
      ]),
    );
    const created = await service.createInvitation(
      '  Beta.Invite@Example.TEST ',
      new Date('2099-01-01T00:00:00Z'),
    );
    expect(created.invitationId).toBe('inv-1');
    expect(created.email).toBe('beta.invite@example.test');
    expect(created.expiresAt).toBe('2099-01-01T00:00:00.000Z');
    // Base64url token with 32 random bytes: 43 characters, URL-safe alphabet.
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const values = capture.values!;
    const expectedHash = createHash('sha256').update(created.token, 'utf8').digest('hex');
    expect(values.tokenHash).toBe(expectedHash);
    expect(values.email).toBe('beta.invite@example.test');
    // The raw token must not appear anywhere in the persisted values object.
    expect(JSON.stringify(values)).not.toContain(created.token);
    expect(JSON.stringify(values)).not.toContain('token"');
    expect('token' in values).toBe(false);
  });

  it('rejects an invalid e-mail before touching the database', async () => {
    const counter = { connects: 0, selects: 0 };
    const service = createBetaInvitation(unusedDatabase(counter));
    await expect(service.createInvitation('not-an-email', new Date())).rejects.toMatchObject({
      code: 'INVITATION_EMAIL_INVALID',
    });
    expect(counter.connects).toBe(0);
    expect(counter.selects).toBe(0);
  });

  it('maps a pending conflict to INVITATION_CONFLICT', async () => {
    const capture: { values?: Record<string, unknown> } = {};
    const service = createBetaInvitation(
      insertCapturingDatabase(capture, () => {
        const error = new Error(
          'duplicate key value violates unique constraint "beta_invitation_pending_email_key"',
        );
        Object.assign(error, { code: '23505', constraint: 'beta_invitation_pending_email_key' });
        throw error;
      }),
    );
    await expect(
      service.createInvitation('beta.invite@example.test', new Date()),
    ).rejects.toMatchObject({ code: 'INVITATION_CONFLICT' });
  });

  it('sanitizes a storage failure from the database', async () => {
    const capture: { values?: Record<string, unknown> } = {};
    const service = createBetaInvitation(
      insertCapturingDatabase(capture, () => {
        throw new Error('relation "core.beta_invitation" does not exist at 10.0.0.9:5432');
      }),
    );
    let failure: unknown = null;
    try {
      await service.createInvitation('beta.invite@example.test', new Date());
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'BetaInvitationError',
      code: 'INVITATION_STORAGE_FAILED',
    });
    expect((failure as Error).message).toBe('INVITATION_STORAGE_FAILED');
    expect(String(failure)).not.toMatch(/relation|does not exist|10\.0\.0\.9|5432|core\./i);
  });
});

describe('beta invitation gate services (unit, pre-flight only)', () => {
  it('rejects malformed tokens before touching the pool', async () => {
    const counter = { connects: 0, selects: 0 };
    const service = createBetaInvitation(unusedDatabase(counter));
    for (const token of ['', 'x'.repeat(600)]) {
      await expect(service.readAcceptableInvitation(token)).rejects.toMatchObject({
        code: 'INVITATION_INVALID',
      });
      await expect(
        service.assertInvitationAcceptableForEmail(token, 'beta@example.test'),
      ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
      await expect(
        service.consumeInvitationForUser(token, { userId: 'user-1', email: 'beta@example.test' }),
      ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    }
    expect(counter.connects).toBe(0);
    expect(counter.selects).toBe(0);
  });

  it('rejects an invalid user id or e-mail during consumption without connecting', async () => {
    const counter = { connects: 0, selects: 0 };
    const service = createBetaInvitation(unusedDatabase(counter));
    await expect(
      service.consumeInvitationForUser('a'.repeat(43), { userId: '', email: 'beta@example.test' }),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    await expect(
      service.consumeInvitationForUser('a'.repeat(43), { userId: 'user-1', email: 'not-an-email' }),
    ).rejects.toMatchObject({ code: 'INVITATION_EMAIL_INVALID' });
    expect(counter.connects).toBe(0);
  });

  it('reports not-admitted for malformed user ids without touching the pool', async () => {
    const counter = { connects: 0, selects: 0 };
    const service = createBetaInvitation(unusedDatabase(counter));
    expect(await service.findAcceptedInvitationForUser('')).toBe(false);
    expect(await service.findAcceptedInvitationForUser('x'.repeat(300))).toBe(false);
    expect(counter.selects).toBe(0);
  });

  it('sanitizes a pool failure during consumption', async () => {
    const database = {
      orm: {
        select: () => {
          throw new Error('orm must not run');
        },
      },
      pool: {
        connect: async () => {
          throw new Error('RAW_POOL_FAILURE 10.0.0.9:5432');
        },
      },
    } as unknown as Database;
    const service = createBetaInvitation(database);
    let failure: unknown = null;
    try {
      await service.consumeInvitationForUser('a'.repeat(43), {
        userId: 'user-1',
        email: 'beta@example.test',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'BetaInvitationError',
      code: 'INVITATION_STORAGE_FAILED',
    });
    expect(String(failure)).not.toMatch(/10\.0\.0\.9|5432|RAW_POOL_FAILURE/);
  });
});

describe('redeemBetaInvitation (unit, pre-flight only)', () => {
  it('rejects malformed tokens before touching the pool', async () => {
    const counter = { connects: 0, selects: 0 };
    const service = createBetaInvitation(unusedDatabase(counter));
    for (const token of ['', 'x'.repeat(600)]) {
      await expect(service.redeemBetaInvitation(token)).rejects.toMatchObject({
        code: 'INVITATION_INVALID',
      });
    }
    await expect(
      service.redeemBetaInvitation(undefined as unknown as string),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    expect(counter.connects).toBe(0);
  });

  it('sanitizes a pool connection failure', async () => {
    const database = {
      orm: {
        select: () => {
          throw new Error('orm must not run');
        },
      },
      pool: {
        connect: async () => {
          throw new Error('RAW_POOL_FAILURE 10.0.0.9:5432');
        },
      },
    } as unknown as Database;
    const service = createBetaInvitation(database);
    let failure: unknown = null;
    try {
      await service.redeemBetaInvitation('a'.repeat(43));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'BetaInvitationError',
      code: 'INVITATION_STORAGE_FAILED',
    });
    expect(String(failure)).not.toMatch(/10\.0\.0\.9|5432|RAW_POOL_FAILURE/);
  });
});
