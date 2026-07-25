export function createBatchResultStore(storageArea) {
  let operation = Promise.resolve();

  return {
    save(message) {
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
          url: message.url || '',
          result: message.result,
          aiContent: message.aiContent || null,
          errorMessage: message.errorMessage || null,
          timestamp: Date.now()
        };
        const existingIndex = results.findIndex((item) =>
          item.batchId === entry.batchId &&
          item.urlIndex === entry.urlIndex
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
        const key = `${entry.batchId}:${entry.urlIndex}`;
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
