import { describe, expect, it } from 'vitest';
import { createTtlCache } from '../../packages/db/src/ttl-cache.js';

describe('ttl cache (STK-F2-02 — cache curto do dashboard)', () => {
  it('devolve o valor dentro do TTL e descarta depois do vencimento', () => {
    let clock = 1_000;
    const cache = createTtlCache<string>({ ttlMs: 30_000, now: () => clock });
    cache.set('org-a|1|{}', 'payload');
    expect(cache.get('org-a|1|{}')).toBe('payload');
    clock += 29_999;
    expect(cache.get('org-a|1|{}')).toBe('payload');
    clock += 1;
    expect(cache.get('org-a|1|{}')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('isola chaves diferentes (organização, versão e filtros)', () => {
    const cache = createTtlCache<string>({ ttlMs: 30_000, now: () => 0 });
    cache.set('org-a|1|{}', 'a1');
    cache.set('org-a|2|{}', 'a2');
    cache.set('org-b|1|{}', 'b1');
    expect(cache.get('org-a|1|{}')).toBe('a1');
    expect(cache.get('org-a|2|{}')).toBe('a2');
    expect(cache.get('org-b|1|{}')).toBe('b1');
    expect(cache.get('org-c|1|{}')).toBeUndefined();
  });

  it('TTL 0 desliga o cache e substitui a chave existente', () => {
    const off = createTtlCache<string>({ ttlMs: 0 });
    off.set('k', 'v');
    expect(off.get('k')).toBeUndefined();
    const cache = createTtlCache<string>({ ttlMs: 1_000, now: () => 0 });
    cache.set('k', 'primeiro');
    cache.set('k', 'segundo');
    expect(cache.get('k')).toBe('segundo');
    expect(cache.size()).toBe(1);
  });

  it('respeita o limite de entradas evictando as mais antigas', () => {
    const cache = createTtlCache<number>({ ttlMs: 60_000, maxEntries: 2, now: () => 0 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size()).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('recusa configuração inválida', () => {
    expect(() => createTtlCache({ ttlMs: -1 })).toThrow('INVALID_CACHE_TTL');
    expect(() => createTtlCache({ ttlMs: 1_000, maxEntries: 0 })).toThrow('INVALID_CACHE_CAPACITY');
  });
});
