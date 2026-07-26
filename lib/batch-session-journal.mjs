export const BATCH_SESSION_JOURNAL_PREFIX =
  'batchWorkerOwnershipV1:';

const JOURNAL_FIELDS = [
  'attempt',
  'batchId',
  'createdAt',
  'ownerPageTabId',
  'ownershipEpoch',
  'requestId',
  'tabId',
  'urlIndex',
  'windowId'
];

function journalKey(requestId) {
  return `${BATCH_SESSION_JOURNAL_PREFIX}${requestId}`;
}

function isExactJournalRecord(record) {
  return record &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    Object.keys(record).sort().join(',') ===
      JOURNAL_FIELDS.join(',') &&
    typeof record.batchId === 'string' &&
    record.batchId.length > 0 &&
    Number.isInteger(record.urlIndex) &&
    record.urlIndex >= 0 &&
    Number.isInteger(record.attempt) &&
    record.attempt > 0 &&
    record.requestId ===
      `${record.batchId}:${record.urlIndex}:${record.attempt}` &&
    (
      record.tabId === null ||
      (Number.isInteger(record.tabId) && record.tabId > 0)
    ) &&
    Number.isInteger(record.windowId) &&
    record.windowId > 0 &&
    Number.isInteger(record.ownerPageTabId) &&
    record.ownerPageTabId > 0 &&
    typeof record.ownershipEpoch === 'string' &&
    record.ownershipEpoch.length > 0 &&
    Number.isFinite(record.createdAt) &&
    record.createdAt > 0;
}

function invalidJournal() {
  const error = new Error('invalid_batch_session_journal');
  error.code = 'invalid_batch_session_journal';
  return error;
}

export function createBatchSessionJournal(sessionArea) {
  if (
    typeof sessionArea?.get !== 'function' ||
    typeof sessionArea?.set !== 'function' ||
    typeof sessionArea?.remove !== 'function'
  ) {
    throw invalidJournal();
  }

  return {
    async write(record) {
      if (!isExactJournalRecord(record)) throw invalidJournal();
      await sessionArea.set({
        [journalKey(record.requestId)]: structuredClone(record)
      });
    },

    async read(requestId) {
      if (typeof requestId !== 'string' || requestId.length === 0) {
        return null;
      }
      const key = journalKey(requestId);
      const values = await sessionArea.get([key]);
      const record = values[key];
      return isExactJournalRecord(record) &&
        record.requestId === requestId
        ? structuredClone(record)
        : null;
    },

    async remove(requestId) {
      if (typeof requestId !== 'string' || requestId.length === 0) {
        throw invalidJournal();
      }
      await sessionArea.remove([journalKey(requestId)]);
    }
  };
}
