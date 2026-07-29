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
        const existingIndex = results.findIndex((item) =>
          item.batchId === message.batchId &&
          item.urlIndex === message.urlIndex &&
          item.attempt === message.attempt
        );
        const existing = existingIndex >= 0 ? results[existingIndex] : null;
        const timestamp = Date.now();
        const entry = {
          batchId: message.batchId,
          urlIndex: message.urlIndex,
          attempt: message.attempt,
          url: message.url || '',
          result: message.result,
          aiContent: message.aiContent || null,
          errorCode: message.errorCode || null,
          errorMessage: message.errorMessage || null,
          timestamp,
          submittedAt: message.result === 'success'
            ? (
                Number.isFinite(message.submittedAt)
                  ? message.submittedAt
                  : (
                      Number.isFinite(existing?.submittedAt)
                        ? existing.submittedAt
                        : timestamp
                    )
              )
            : null
        };
        const hasNewerAttempt = results.some((item) =>
          item.batchId === entry.batchId &&
          item.urlIndex === entry.urlIndex &&
          Number.isInteger(item.attempt) &&
          item.attempt > entry.attempt
        );
        if (hasNewerAttempt) return;

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
