const DEFAULT_DB_NAME = 'auto_comment_outlinks';
const DATABASE_VERSION = 1;
const STORE_NAME = 'outlink_records';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionCompletion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error || new Error('IndexedDB transaction aborted')
    );
    transaction.onerror = () => {};
  });
}

function openDatabase(indexedDBImpl, dbName) {
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(dbName, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database.objectStoreNames.contains(STORE_NAME)) return;
      const records = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      records.createIndex('by_source_link', ['sourceUrl', 'url'], { unique: true });
      records.createIndex('by_last_captured', 'lastCapturedAt');
      records.createIndex('by_source_host', 'sourceHost');
      records.createIndex('by_target_host', 'host');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`IndexedDB open blocked for ${dbName}`));
  });
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch (_) {
    return '';
  }
}

function safeHost(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch (_) {
    return String(value || '').trim().toLowerCase();
  }
}

function normalizedText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeExport(payload = {}) {
  const sourceUrl = safeHttpUrl(payload.sourceUrl);
  if (!sourceUrl) throw new TypeError('A valid source URL is required');
  const capturedAt = Number.isFinite(payload.capturedAt)
    ? payload.capturedAt
    : Date.now();
  const sourceHost = safeHost(payload.sourceHost || sourceUrl);
  const sourceTitle = normalizedText(payload.sourceTitle, 500);
  const seen = new Set();
  const links = [];
  for (const rawLink of Array.isArray(payload.links) ? payload.links.slice(0, 5000) : []) {
    const url = safeHttpUrl(rawLink?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({
      url,
      host: safeHost(rawLink?.host || url),
      text: normalizedText(rawLink?.text, 2000),
      isNofollow: rawLink?.isNofollow === true,
      isDofollow: rawLink?.isNofollow !== true
    });
  }
  return { sourceUrl, sourceHost, sourceTitle, capturedAt, links };
}

function normalizeFilter(filter = {}) {
  return {
    sourceHost: normalizedText(filter.sourceHost, 255).toLowerCase(),
    targetHost: normalizedText(filter.targetHost, 255).toLowerCase(),
    keyword: normalizedText(filter.keyword, 500).toLowerCase(),
    linkType: ['dofollow', 'nofollow'].includes(filter.linkType)
      ? filter.linkType
      : ''
  };
}

function matches(record, filter) {
  if (filter.sourceHost && !record.sourceHost.includes(filter.sourceHost)) return false;
  if (filter.targetHost && !record.host.includes(filter.targetHost)) return false;
  if (
    filter.keyword
    && !`${record.url}\n${record.text}\n${record.sourceUrl}`
      .toLowerCase()
      .includes(filter.keyword)
  ) return false;
  if (filter.linkType === 'dofollow' && !record.isDofollow) return false;
  if (filter.linkType === 'nofollow' && !record.isNofollow) return false;
  return true;
}

function compareNewest(left, right) {
  if (left.lastCapturedAt !== right.lastCapturedAt) {
    return right.lastCapturedAt - left.lastCapturedAt;
  }
  return String(left.id).localeCompare(String(right.id));
}

export async function openOutlinkRecordDb({
  indexedDBImpl = globalThis.indexedDB,
  dbName = DEFAULT_DB_NAME
} = {}) {
  if (!indexedDBImpl) throw new Error('IndexedDB is unavailable');
  const database = await openDatabase(indexedDBImpl, dbName);

  async function saveExport(rawPayload) {
    const payload = normalizeExport(rawPayload);
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const sourceIndex = store.index('by_source_link');
    let inserted = 0;
    let updated = 0;

    for (const link of payload.links) {
      const existing = await requestResult(
        sourceIndex.get([payload.sourceUrl, link.url])
      );
      if (existing) {
        store.put({
          ...existing,
          ...link,
          sourceHost: payload.sourceHost,
          sourceTitle: payload.sourceTitle,
          lastCapturedAt: payload.capturedAt,
          captureCount: Number(existing.captureCount || 1) + 1
        });
        updated += 1;
      } else {
        store.add({
          id: globalThis.crypto?.randomUUID?.()
            || `${payload.capturedAt}-${inserted}-${Math.random().toString(36).slice(2)}`,
          sourceUrl: payload.sourceUrl,
          sourceHost: payload.sourceHost,
          sourceTitle: payload.sourceTitle,
          ...link,
          firstCapturedAt: payload.capturedAt,
          lastCapturedAt: payload.capturedAt,
          captureCount: 1
        });
        inserted += 1;
      }
    }
    await transactionCompletion(transaction);
    return {
      inserted,
      updated,
      total: payload.links.length,
      capturedAt: payload.capturedAt
    };
  }

  async function allMatching(filter = {}) {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const records = await requestResult(
      transaction.objectStore(STORE_NAME).getAll()
    );
    await transactionCompletion(transaction);
    const normalized = normalizeFilter(filter);
    return records.filter((record) => matches(record, normalized)).sort(compareNewest);
  }

  return {
    async saveExport(payload) {
      return saveExport(payload);
    },
    async list({ filter = {}, offset = 0, limit = 100 } = {}) {
      const records = await allMatching(filter);
      const safeOffset = Number.isInteger(offset) && offset > 0 ? offset : 0;
      const safeLimit = Number.isInteger(limit) && limit > 0
        ? Math.min(limit, 500)
        : 100;
      return {
        records: records.slice(safeOffset, safeOffset + safeLimit),
        total: records.length,
        offset: safeOffset,
        limit: safeLimit
      };
    },
    async exportRecords(filter = {}) {
      return allMatching(filter);
    },
    async summary() {
      const records = await allMatching();
      return {
        total: records.length,
        sourceHosts: new Set(records.map((record) => record.sourceHost)).size,
        targetHosts: new Set(records.map((record) => record.host)).size,
        lastCapturedAt: records[0]?.lastCapturedAt || null
      };
    },
    async deleteRecords(ids = []) {
      const safeIds = [...new Set(
        (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id)
      )].slice(0, 5000);
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      safeIds.forEach((id) => store.delete(id));
      await transactionCompletion(transaction);
      return { deleted: safeIds.length };
    },
    async clear() {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).clear();
      await transactionCompletion(transaction);
      return { cleared: true };
    },
    close() {
      database.close();
    }
  };
}
