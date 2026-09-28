/**
 * STK-F2-02 — cache curto em memória para o dashboard analítico (Plano §8.5:
 * "consultas indexadas e cache curto"; materialized views ficam para depois de
 * medição real). O cache é por processo, por chave (organização + versão +
 * filtros) e com TTL explícito — nunca compartilha dados entre chaves.
 */
export type TtlCache<V> = {
  /** Retorna o valor vivo ou `undefined` (ausente ou expirado). */
  get(key: string): V | undefined;
  /** Guarda o valor; TTL 0 desliga o cache (sempre `undefined` no `get`). */
  set(key: string, value: V): void;
  /** Entradas vivas — usado apenas por testes/observação. */
  size(): number;
};

export function createTtlCache<V>(options: {
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
}): TtlCache<V> {
  const { ttlMs, maxEntries = 256, now = Date.now } = options;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('INVALID_CACHE_TTL');
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('INVALID_CACHE_CAPACITY');
  const entries = new Map<string, { value: V; expiresAt: number }>();
  const alive = () => {
    const clock = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= clock) entries.delete(key);
      else break; // insertion order: expired keys can only be older
    }
  };
  return {
    get(key) {
      if (ttlMs === 0) return undefined;
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      if (ttlMs === 0) return;
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      if (entries.size <= maxEntries) return;
      alive();
      // Still over capacity: evict the oldest inserted keys.
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries) break;
        entries.delete(oldest);
      }
    },
    size() {
      alive();
      return entries.size;
    },
  };
}
