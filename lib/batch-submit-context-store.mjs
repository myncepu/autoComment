const STORAGE_KEY = 'batchSubmitContextsByTab';
const RECOVERY_KEY = 'batchSubmitRecoveriesByTask';
const RECOVERY_SEALS_KEY = 'batchSubmitRecoverySealsByTab';
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

function getObject(data, key) {
  const value = data?.[key];
  return value && typeof value === 'object' ? value : {};
}

function recoverySealKey(tabId, expected) {
  return JSON.stringify([tabId, expected.batchId, expected.urlIndex]);
}

function recoveryEntryKey(context) {
  const revision = context.history?.historyRevision;
  return JSON.stringify([
    context.batchId,
    context.urlIndex,
    revision?.capturedAt ?? '',
    revision?.recordedAt ?? '',
    revision?.sequence ?? '',
    revision?.id ?? context.timestamp ?? ''
  ]);
}

function putRecovery(recoveries, context, tabId, recoveredAt, reason) {
  const { timestamp: _timestamp, ...payload } = context;
  recoveries[recoveryEntryKey(context)] = {
    ...payload,
    sourceTabId: tabId,
    recoveredAt,
    recoveryReason: reason
  };
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
    return getObject(data, STORAGE_KEY);
  };

  const readRecoveryState = async () => {
    const data = await storageArea.get([
      STORAGE_KEY,
      RECOVERY_KEY,
      RECOVERY_SEALS_KEY
    ]);
    return {
      contexts: getObject(data, STORAGE_KEY),
      recoveries: getObject(data, RECOVERY_KEY),
      seals: getObject(data, RECOVERY_SEALS_KEY)
    };
  };

  return {
    save(tabId, context) {
      return enqueue(async () => {
        const { contexts, recoveries, seals } = await readRecoveryState();
        const timestamp = now();
        const savedContext = { ...context, timestamp };
        const sealKey = recoverySealKey(tabId, context);
        const seal = seals[sealKey];
        if (seal && contextsMatch(savedContext, seal)) {
          putRecovery(
            recoveries,
            savedContext,
            tabId,
            timestamp,
            seal.reason || 'sealed'
          );
          delete seals[sealKey];
          const contextKey = String(tabId);
          if (contextsMatch(contexts[contextKey], seal)) {
            delete contexts[contextKey];
          }
          await storageArea.set({
            [STORAGE_KEY]: contexts,
            [RECOVERY_KEY]: recoveries,
            [RECOVERY_SEALS_KEY]: seals
          });
          return { recovered: true };
        }

        contexts[String(tabId)] = savedContext;
        await storageArea.set({ [STORAGE_KEY]: contexts });
        return { recovered: false };
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
    },

    sealAndRecover(tabId, expected, reason = 'unknown') {
      return enqueue(async () => {
        const { contexts, recoveries, seals } = await readRecoveryState();
        const contextKey = String(tabId);
        const context = contexts[contextKey];
        const sealedAt = now();
        let recovered = false;
        if (contextsMatch(context, expected)) {
          putRecovery(recoveries, context, tabId, sealedAt, reason);
          delete contexts[contextKey];
          recovered = true;
        } else {
          seals[recoverySealKey(tabId, expected)] = {
            batchId: expected.batchId,
            urlIndex: expected.urlIndex,
            reason,
            sealedAt
          };
        }
        await storageArea.set({
          [STORAGE_KEY]: contexts,
          [RECOVERY_KEY]: recoveries,
          [RECOVERY_SEALS_KEY]: seals
        });
        return { sealed: true, recovered };
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
    if (message?.type === 'BATCH_RECOVER_SUBMIT_CONTEXT') {
      if (
        sender?.id !== chromeApi.runtime.id
        || !Number.isInteger(message.tabId)
        || typeof message.batchId !== 'string'
        || !Number.isInteger(message.urlIndex)
      ) {
        sendResponse({ ok: false, error: 'invalid_submit_context_recovery' });
        return false;
      }
      Promise.resolve(store.sealAndRecover(
        message.tabId,
        {
          batchId: message.batchId,
          urlIndex: message.urlIndex
        },
        message.reason
      ))
        .then((result) => sendResponse({ ok: true, ...result }))
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
