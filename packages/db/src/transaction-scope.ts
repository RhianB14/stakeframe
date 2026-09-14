import { AsyncLocalStorage } from 'node:async_hooks';
import type { SQLWrapper } from 'drizzle-orm';

/** Minimal surface of a Drizzle transaction: raw SQL execution on its own connection. */
export type TransactionExecutor = {
  execute: (query: SQLWrapper | string) => Promise<unknown>;
};

const transactionStorage = new AsyncLocalStorage<TransactionExecutor>();

/**
 * Wraps a Drizzle instance so every `transaction()` call captures the active transaction in an
 * AsyncLocalStorage. Code running inside that transaction — including the auth library's
 * database hooks — can then run statements on the SAME connection via `currentTransaction()`
 * and take part in the same commit/rollback. All other operations pass through untouched.
 */
export function captureTransactions<T extends object>(orm: T): T {
  return new Proxy(orm, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      const transaction = Reflect.get(target, property) as
        ((callback: (tx: TransactionExecutor) => Promise<unknown>) => Promise<unknown>) | undefined;
      if (typeof transaction !== 'function') return transaction;
      return (callback: (tx: TransactionExecutor) => Promise<unknown>) =>
        transaction.call(target, (tx: TransactionExecutor) =>
          transactionStorage.run(tx, () => callback(tx)),
        );
    },
  });
}

/** The transaction the current async flow is running inside, when there is one. */
export function currentTransaction(): TransactionExecutor | undefined {
  return transactionStorage.getStore();
}
