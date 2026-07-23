export const DEFAULT_BATCH_CONCURRENCY = 3;
export const MIN_BATCH_CONCURRENCY = 1;
export const MAX_BATCH_CONCURRENCY = 10;

export function normalizeBatchConcurrency(
  value,
  fallback = DEFAULT_BATCH_CONCURRENCY
) {
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_BATCH_CONCURRENCY ||
    parsed > MAX_BATCH_CONCURRENCY
  ) {
    return fallback;
  }
  return parsed;
}

export function isBatchConfirmationFor(message, { batchId, totalCount }) {
  return Boolean(
    message &&
    message.type === 'BATCH_CONFIRMED' &&
    typeof batchId === 'string' &&
    batchId.length > 0 &&
    message.batchId === batchId &&
    Number.isInteger(message.urlIndex) &&
    message.urlIndex >= 0 &&
    message.urlIndex < totalCount
  );
}

export class BatchScheduler {
  constructor({ totalCount, concurrency, processedIndices = [] }) {
    this.totalCount = totalCount;
    this.concurrency = normalizeBatchConcurrency(concurrency);
    this.state = 'idle';
    this.active = new Set();
    this.settled = new Set(processedIndices);
    this.rebuildPending();
  }

  rebuildPending() {
    this.pending = [];
    for (let index = 0; index < this.totalCount; index += 1) {
      if (!this.settled.has(index)) this.pending.push(index);
    }
  }

  start() {
    this.state = 'running';
  }

  stop() {
    this.state = 'stopped';
  }

  resume(processedIndices = []) {
    this.active.clear();
    this.settled = new Set(processedIndices);
    this.rebuildPending();
    this.state = 'running';
  }

  takeAvailable() {
    if (this.state !== 'running') return [];
    const claimed = [];
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const index = this.pending.shift();
      if (this.active.has(index) || this.settled.has(index)) continue;
      this.active.add(index);
      claimed.push(index);
    }
    return claimed;
  }

  settle(index) {
    if (this.settled.has(index)) return false;
    this.active.delete(index);
    this.settled.add(index);
    return true;
  }

  get activeIndices() {
    return [...this.active];
  }

  get isComplete() {
    return this.totalCount > 0 && this.settled.size >= this.totalCount;
  }
}
