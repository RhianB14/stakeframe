export type PendingUpload = { owner: string; key: string; image: string; caption: string };
function tabSlot() {
  const name = 'stakeframe.upload-slot';
  let slot = sessionStorage.getItem(name);
  if (!slot) {
    slot = crypto.randomUUID();
    sessionStorage.setItem(name, slot);
  }
  return slot;
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
  const db = await uploadDb();
  try {
    return await new Promise<PendingUpload | null>((resolve, reject) => {
      const tx = db.transaction('pending', 'readonly');
      const read = tx.objectStore('pending').get(tabSlot());
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
  const db = await uploadDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      const store = tx.objectStore('pending');
      if (clearAll) store.clear();
      else if (value) store.put(value, tabSlot());
      else store.delete(tabSlot());
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('Não foi possível guardar o envio para recuperação.'));
      tx.onabort = () => reject(new Error('O armazenamento do envio foi interrompido.'));
    });
  } finally {
    db.close();
  }
}
