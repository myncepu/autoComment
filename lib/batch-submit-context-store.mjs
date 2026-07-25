const STORAGE_KEY = 'batchSubmitContextsByTab';
const MAX_AGE_MS = 10 * 60 * 1000;

function revisionsMatch(actual, expected) {
  if (actual == null || expected == null) {
    return actual == null && expected == null;
  }
  return ['capturedAt', 'recordedAt', 'sequence', 'id']
    .every((field) => actual[field] === expected[field]);
}

function contextsMatch(context, expected = {}) {
  if (
    !context
    || context.batchId !== expected.batchId
    || context.urlIndex !== expected.urlIndex
  ) {
    return false;
  }
  return !Object.hasOwn(expected, 'historyRevision') || revisionsMatch(
    context.history?.historyRevision ?? null,
    expected.historyRevision ?? null
  );
}

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
    },

    hasMatching(tabId, expected) {
      return enqueue(async () => {
        const contexts = await readMap();
        return contextsMatch(contexts[String(tabId)], expected);
      });
    },

    clearIfMatches(tabId, expected) {
      return enqueue(async () => {
        const contexts = await readMap();
        const key = String(tabId);
        if (!contextsMatch(contexts[key], expected)) return false;

        delete contexts[key];
        await storageArea.set({ [STORAGE_KEY]: contexts });
        return true;
      });
    }
  };
}

export function installBatchSubmitContextListener(chromeApi, store) {
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const methods = {
      BATCH_SAVE_SUBMIT_CONTEXT: () => store.save(sender.tab.id, message.context),
      BATCH_GET_SUBMIT_CONTEXT: () => store.get(sender.tab.id),
      BATCH_CLEAR_SUBMIT_CONTEXT: () => (
        message.match
          ? store.clearIfMatches(sender.tab.id, message.match)
          : store.clear(sender.tab.id)
      )
    };
    if (message?.type === 'BATCH_HAS_SUBMIT_CONTEXT') {
      if (
        sender?.id !== chromeApi.runtime.id
        || !Number.isInteger(message.tabId)
        || typeof message.batchId !== 'string'
        || !Number.isInteger(message.urlIndex)
      ) {
        sendResponse({ ok: false, error: 'invalid_submit_context_query' });
        return false;
      }
      Promise.resolve(store.hasMatching(message.tabId, {
        batchId: message.batchId,
        urlIndex: message.urlIndex
      }))
        .then((unresolved) => sendResponse({ ok: true, unresolved }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
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
