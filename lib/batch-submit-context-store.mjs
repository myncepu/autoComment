const STORAGE_KEY = 'batchSubmitContextsByTab';
const MAX_AGE_MS = 10 * 60 * 1000;

export function createBatchSubmitContextStore(
  storageArea,
  { now = Date.now, maxAgeMs = MAX_AGE_MS } = {}
) {
  let operation = Promise.resolve();

  const enqueue = (work) => {
    const next = operation.then(work, work);
    operation = next.catch(() => {});
    return next;
  };

  const readMap = async () => {
    const data = await storageArea.get(STORAGE_KEY);
    const value = data?.[STORAGE_KEY];
    return value && typeof value === 'object' ? value : {};
  };

  return {
    save(tabId, context) {
      return enqueue(async () => {
        const contexts = await readMap();
        contexts[String(tabId)] = { ...context, timestamp: now() };
        await storageArea.set({ [STORAGE_KEY]: contexts });
      });
    },

    get(tabId) {
      return enqueue(async () => {
        const contexts = await readMap();
        const key = String(tabId);
        const context = contexts[key];
        if (!context) return null;
        if (now() - context.timestamp <= maxAgeMs) return context;

        delete contexts[key];
        await storageArea.set({ [STORAGE_KEY]: contexts });
        return null;
      });
    },

    clear(tabId) {
      return enqueue(async () => {
        const contexts = await readMap();
        delete contexts[String(tabId)];
        await storageArea.set({ [STORAGE_KEY]: contexts });
      });
    }
  };
}

export function installBatchSubmitContextListener(chromeApi, store) {
  chromeApi.tabs.onRemoved.addListener((tabId) => {
    void store.clear(tabId).catch(() => {});
  });

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const methods = {
      BATCH_SAVE_SUBMIT_CONTEXT: () => store.save(sender.tab.id, message.context),
      BATCH_GET_SUBMIT_CONTEXT: () => store.get(sender.tab.id),
      BATCH_CLEAR_SUBMIT_CONTEXT: () => store.clear(sender.tab.id)
    };
    const method = methods[message?.type];
    if (!method) return undefined;
    if (!Number.isInteger(sender?.tab?.id)) {
      sendResponse({ ok: false, error: 'missing_sender_tab' });
      return false;
    }

    Promise.resolve(method())
      .then((context) => sendResponse({
        ok: true,
        ...(message.type === 'BATCH_GET_SUBMIT_CONTEXT' ? { context } : {})
      }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  });
}
