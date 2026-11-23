(function () {
    const DB_NAME = 'spx_route_os';
    const DB_VERSION = 1;
    const EVIDENCE_STORE = 'evidence';
    let dbPromise = null;

    function openDatabase() {
        if (dbPromise) return dbPromise;
        const promise = new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                reject(new Error('IndexedDB indisponível neste dispositivo.'));
                return;
            }
            const request = window.indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(EVIDENCE_STORE)) {
                    db.createObjectStore(EVIDENCE_STORE, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Falha ao abrir o armazenamento local.'));
        });
        dbPromise = promise;
        promise.catch(() => {
            if (dbPromise === promise) dbPromise = null;
        });
        return promise;
    }

    async function run(storeName, mode, action) {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            let result;
            try {
                result = action(store);
            } catch (error) {
                reject(error);
                return;
            }
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error || new Error('Falha na operação local.'));
            tx.onabort = () => reject(tx.error || new Error('Operação local cancelada.'));
        });
    }

    function requestResult(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Falha na consulta local.'));
        });
    }

    window.SPXStore = {
        async putEvidence(record) {
            if (!record || !record.id) throw new Error('Comprovante sem identificador.');
            await run(EVIDENCE_STORE, 'readwrite', store => store.put(record));
            return record;
        },
        async getEvidence(id) {
            const db = await openDatabase();
            return requestResult(db.transaction(EVIDENCE_STORE, 'readonly').objectStore(EVIDENCE_STORE).get(id));
        },
        async listEvidence(filter) {
            const db = await openDatabase();
            const records = await requestResult(db.transaction(EVIDENCE_STORE, 'readonly').objectStore(EVIDENCE_STORE).getAll());
            if (!filter) return records;
            return records.filter(record => Object.entries(filter).every(([key, value]) => record[key] === value));
        },
        async deleteEvidence(id) {
            await run(EVIDENCE_STORE, 'readwrite', store => store.delete(id));
        },
        async deleteEvidenceForStop(stopId) {
            const records = await this.listEvidence({ stopId });
            await Promise.all(records.map(record => this.deleteEvidence(record.id)));
        },
        async deleteEvidenceForPackage(stopId, packageId, retainedPackageIds = []) {
            const retained = new Set(retainedPackageIds.map(String));
            const records = await this.listEvidence({ stopId });
            const removable = records.filter(record => Array.isArray(record.packageIds) &&
                record.packageIds.map(String).includes(String(packageId)) &&
                !record.packageIds.map(String).some(id => retained.has(id)));
            await Promise.all(removable.map(record => this.deleteEvidence(record.id)));
        }
    };
})();
