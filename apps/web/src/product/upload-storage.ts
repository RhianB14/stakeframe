export type PendingUpload = { owner: string; key: string; image: string; caption: string };
let slotPromise: Promise<string> | undefined;
async function claimSlot() {
  const name = 'stakeframe.upload-slot';
  if (!navigator.locks)
    throw new Error(
      'Este navegador não permite recuperar envios com segurança. Use um navegador atualizado.',
    );
  let slot = sessionStorage.getItem(name) ?? crypto.randomUUID();
  for (;;) {
    const claimed = await new Promise<boolean>((resolve, reject) => {
      void navigator.locks
        .request(`stakeframe.upload:${slot}`, { ifAvailable: true }, async (lock) => {
          resolve(!!lock);
          // The browser releases this document's lock on reload/close. A copied
          // sessionStorage slot in a second live tab cannot own the same record.
          if (lock) await new Promise<void>(() => undefined);
        })
        .catch(reject);
    });
    if (claimed) {
      sessionStorage.setItem(name, slot);
      return slot;
    }
    slot = crypto.randomUUID();
  }
}
function tabSlot() {
  return (slotPromise ??= claimSlot());
}
async function uploadDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('stakeframe-pending-upload', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('pending');
    request.onerror = () => reject(new Error('Não foi possível guardar o envio para recuperação.'));
    request.onsuccess = () => resolve(request.result);
  });
}
export async function readPendingUpload(owner: string) {
  const slot = await tabSlot();
  const db = await uploadDb();
  try {
    return await new Promise<PendingUpload | null>((resolve, reject) => {
      const tx = db.transaction('pending', 'readonly');
      const read = tx.objectStore('pending').get(slot);
      read.onerror = () => reject(new Error('Não foi possível ler o envio pendente.'));
      read.onsuccess = () => {
        const value = read.result as PendingUpload | undefined;
        resolve(value?.owner === owner ? value : null);
      };
    });
  } finally {
    db.close();
  }
}
export async function savePendingUpload(value: PendingUpload | null, clearAll = false) {
  const slot = clearAll ? '' : await tabSlot();
  const db = await uploadDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      const store = tx.objectStore('pending');
      if (clearAll) store.clear();
      else if (value) store.put(value, slot);
      else store.delete(slot);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('Não foi possível guardar o envio para recuperação.'));
      tx.onabort = () => reject(new Error('O armazenamento do envio foi interrompido.'));
    });
  } finally {
    db.close();
  }
}
