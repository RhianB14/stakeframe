import { describe, expect, it } from 'vitest';
import {
  assertSecretDirectoryPlatform,
  inspectSecretDirectories,
} from '../../scripts/deployment/secrets.mjs';

describe('Gate de diretórios de segredos do deployment', () => {
  it('aceita diretório POSIX 0700', () => {
    expect(assertSecretDirectoryPlatform(0o700, 'linux')).toBe(0o700);
  });

  it.each([0o750, 0o755])('recusa diretório POSIX %o com bits de grupo ou outros', (mode) => {
    expect(() => assertSecretDirectoryPlatform(mode, 'linux')).toThrow();
  });

  it('não recusa no Windows apenas pelos bits POSIX do mode', () => {
    expect(assertSecretDirectoryPlatform(0o755, 'win32')).toBe(0o755);
    expect(assertSecretDirectoryPlatform(0o777, 'win32')).toBe(0o777);
  });

  it('recusa entrada que não é diretório', async () => {
    await expect(
      inspectSecretDirectories(['/run/secrets'], {
        platform: 'linux',
        lstat: async () => ({ isDirectory: () => false, mode: 0o700 }),
      }),
    ).rejects.toThrow('SECRET_DIRECTORY_NOT_A_DIRECTORY');
  });

  it('verifica diretórios repetidos apenas uma vez, sem comportamento divergente', async () => {
    let calls = 0;
    const once = await inspectSecretDirectories(['/run/secrets'], {
      platform: 'linux',
      lstat: async () => {
        calls += 1;
        return { isDirectory: () => true, mode: 0o700 };
      },
    });
    const repeated = await inspectSecretDirectories(
      ['/run/secrets', '/run/secrets', '/run/secrets'],
      {
        platform: 'linux',
        lstat: async () => {
          calls += 1;
          return { isDirectory: () => true, mode: 0o700 };
        },
      },
    );
    expect(calls).toBe(2); // uma por chamada de inspectSecretDirectories
    expect(once).toEqual(repeated);
    expect(repeated.get('/run/secrets')).toBe(0o700);
  });
});
