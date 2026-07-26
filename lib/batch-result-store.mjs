function hasCompleteResultIdentity(message) {
  return (
    typeof message?.batchId === 'string'
    && message.batchId.length > 0
    && Number.isInteger(message.urlIndex)
    && message.urlIndex >= 0
    && Number.isInteger(message.attempt)
    && message.attempt >= 1
  );
}

export function createBatchResultStore(storageArea) {
  let operation = Promise.resolve();

  return {
    save(message) {
      if (!hasCompleteResultIdentity(message)) {
        return Promise.reject(new Error('invalid_batch_result_identity'));
      }
      const saveOperation = operation.then(async () => {
        const data = await storageArea.get([
          'batchResults',
          'batchReportedUrls'
        ]);
        const results = Array.isArray(data.batchResults)
          ? data.batchResults
          : [];
        const entry = {
          batchId: message.batchId,
          urlIndex: message.urlIndex,
          attempt: message.attempt,
          url: message.url || '',
          result: message.result,
          aiContent: message.aiContent || null,
          errorCode: message.errorCode || null,
          errorMessage: message.errorMessage || null,
          timestamp: Date.now()
        };
        const hasNewerAttempt = results.some((item) =>
          item.batchId === entry.batchId &&
          item.urlIndex === entry.urlIndex &&
          Number.isInteger(item.attempt) &&
          item.attempt > entry.attempt
        );
        if (hasNewerAttempt) return;

        const existingIndex = results.findIndex((item) =>
          item.batchId === entry.batchId &&
          item.urlIndex === entry.urlIndex &&
          item.attempt === entry.attempt
        );
        if (existingIndex >= 0) {
          results[existingIndex] = { ...results[existingIndex], ...entry };
        } else {
          results.push(entry);
        }
        while (results.length > 100) results.shift();

        const reported = Array.isArray(data.batchReportedUrls)
          ? data.batchReportedUrls
          : [];
        const key = `${entry.batchId}:${entry.urlIndex}:${entry.attempt}`;
        if (!reported.includes(key)) reported.push(key);
        while (reported.length > 500) reported.shift();

        await storageArea.set({
          batchResults: results,
          batchReportedUrls: reported
        });
      });
      operation = saveOperation.catch(() => {});
      return saveOperation;
    }
  };
}
