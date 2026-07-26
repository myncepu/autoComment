const STORAGE_KEY = 'batchSubmitContextsByTab';
const RECOVERY_KEY = 'batchSubmitRecoveriesByTask';
const RECOVERY_SEALS_KEY = 'batchSubmitRecoverySealsByTab';
const MAX_AGE_MS = 10 * 60 * 1000;
const ASSIGNMENT_IDENTITY_FIELDS = [
  'taskId',
  'profileId',
  'promotionSiteId'
];

function normalizeTaskIdentity(context) {
  if (
    typeof context?.batchId !== 'string'
    || context.batchId === ''
    || !Number.isInteger(context?.urlIndex)
    || context.urlIndex < 0
    || !Number.isInteger(context?.attempt)
    || context.attempt <= 0
  ) {
    throw new Error('invalid_submit_context_identity');
  }
  const presentFields = ASSIGNMENT_IDENTITY_FIELDS.filter(
    (field) => Object.hasOwn(context, field)
  );
  if (presentFields.length === 0) {
    return {
      ...context,
      taskId: `${context.batchId}:legacy:${context.urlIndex}`,
      profileId: 'default-profile',
      promotionSiteId: 'default-promotion-site'
    };
  }
  if (
    presentFields.length !== ASSIGNMENT_IDENTITY_FIELDS.length
    || ASSIGNMENT_IDENTITY_FIELDS.some(
      (field) => typeof context[field] !== 'string' || context[field] === ''
    )
  ) {
    throw new Error('invalid_submit_context_identity');
  }
  return { ...context };
}

function taskIdentityOnly(context) {
  const normalized = normalizeTaskIdentity(context);
  return {
    batchId: normalized.batchId,
    taskId: normalized.taskId,
    urlIndex: normalized.urlIndex,
    profileId: normalized.profileId,
    promotionSiteId: normalized.promotionSiteId,
    attempt: normalized.attempt
  };
}

function revisionsMatch(actual, expected) {
  if (actual == null || expected == null) {
    return actual == null && expected == null;
  }
  return ['capturedAt', 'recordedAt', 'sequence', 'id']
    .every((field) => actual[field] === expected[field]);
}

function contextsMatch(context, expected = {}) {
  let actualIdentity;
  let expectedIdentity;
  try {
    actualIdentity = normalizeTaskIdentity(context);
    expectedIdentity = normalizeTaskIdentity(expected);
  } catch (_) {
    return false;
  }
  if (
    actualIdentity.batchId !== expectedIdentity.batchId
    || actualIdentity.taskId !== expectedIdentity.taskId
    || actualIdentity.urlIndex !== expectedIdentity.urlIndex
    || actualIdentity.profileId !== expectedIdentity.profileId
    || actualIdentity.promotionSiteId !== expectedIdentity.promotionSiteId
    || actualIdentity.attempt !== expectedIdentity.attempt
  ) return false;
  return !Object.hasOwn(expected, 'historyRevision') || revisionsMatch(
    context.history?.historyRevision ?? null,
    expected.historyRevision ?? null
  );
}

function hasCompleteTaskIdentity(context) {
  try {
    normalizeTaskIdentity(context);
    return true;
  } catch (_) {
    return false;
  }
}

function isStaleAttempt(context, savedContext) {
  let actualIdentity;
  let savedIdentity;
  try {
    actualIdentity = normalizeTaskIdentity(context);
    savedIdentity = normalizeTaskIdentity(savedContext);
  } catch (_) {
    return false;
  }
  return (
    actualIdentity.batchId === savedIdentity.batchId
    && actualIdentity.taskId === savedIdentity.taskId
    && actualIdentity.urlIndex === savedIdentity.urlIndex
    && actualIdentity.profileId === savedIdentity.profileId
    && actualIdentity.promotionSiteId === savedIdentity.promotionSiteId
    && actualIdentity.attempt > savedIdentity.attempt
  );
}

function getObject(data, key) {
  const value = data?.[key];
  return value && typeof value === 'object' ? value : {};
}

function recoverySealKey(tabId, expected) {
  const identity = normalizeTaskIdentity(expected);
  return JSON.stringify([
    tabId,
    identity.batchId,
    identity.taskId,
    identity.urlIndex,
    identity.profileId,
    identity.promotionSiteId,
    identity.attempt
  ]);
}

function recoveryEntryKey(context) {
  const identity = normalizeTaskIdentity(context);
  const revision = context.history?.historyRevision;
  return JSON.stringify([
    identity.batchId,
    identity.taskId,
    identity.urlIndex,
    identity.profileId,
    identity.promotionSiteId,
    identity.attempt,
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
        const normalizedContext = normalizeTaskIdentity(context);
        const { contexts, recoveries, seals } = await readRecoveryState();
        const timestamp = now();
        const savedContext = { ...normalizedContext, timestamp };
        const sealKey = recoverySealKey(tabId, normalizedContext);
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

        const contextKey = String(tabId);
        if (isStaleAttempt(contexts[contextKey], savedContext)) {
          throw new Error('stale_submit_context_attempt');
        }
        contexts[contextKey] = savedContext;
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
        const normalizedExpected = normalizeTaskIdentity(expected);
        const { contexts, recoveries, seals } = await readRecoveryState();
        const contextKey = String(tabId);
        const context = contexts[contextKey];
        const sealedAt = now();
        let recovered = false;
        if (contextsMatch(context, normalizedExpected)) {
          putRecovery(recoveries, context, tabId, sealedAt, reason);
          delete contexts[contextKey];
          recovered = true;
        } else {
          seals[recoverySealKey(tabId, normalizedExpected)] = {
            batchId: normalizedExpected.batchId,
            taskId: normalizedExpected.taskId,
            urlIndex: normalizedExpected.urlIndex,
            profileId: normalizedExpected.profileId,
            promotionSiteId: normalizedExpected.promotionSiteId,
            attempt: normalizedExpected.attempt,
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

export function installBatchSubmitContextListener(
  chromeApi,
  store,
  {
    runProofBoundTaskHook,
    runOwnerPageRecoveryHook
  } = {}
) {
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'BATCH_HAS_SUBMIT_CONTEXT') {
      if (
        sender?.id !== chromeApi.runtime.id
        || !Number.isInteger(message.tabId)
        || !hasCompleteTaskIdentity(message)
      ) {
        sendResponse({ ok: false, error: 'invalid_submit_context_query' });
        return false;
      }
      Promise.resolve(store.hasMatching(message.tabId, {
        batchId: message.batchId,
        ...(message.taskId ? { taskId: message.taskId } : {}),
        urlIndex: message.urlIndex,
        ...(message.profileId ? { profileId: message.profileId } : {}),
        ...(message.promotionSiteId
          ? { promotionSiteId: message.promotionSiteId }
          : {}),
        attempt: message.attempt
      }))
        .then((unresolved) => sendResponse({ ok: true, unresolved }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    if (message?.type === 'BATCH_RECOVER_SUBMIT_CONTEXT') {
      if (
        sender?.id !== chromeApi.runtime.id
        || !Number.isInteger(message.tabId)
        || !hasCompleteTaskIdentity(message)
      ) {
        sendResponse({ ok: false, error: 'invalid_submit_context_recovery' });
        return false;
      }
      if (typeof runOwnerPageRecoveryHook !== 'function') {
        sendResponse({
          ok: false,
          error: 'ownership_proof_unavailable'
        });
        return false;
      }
      const identity = taskIdentityOnly(message);
      Promise.resolve(runOwnerPageRecoveryHook(
        identity,
        sender,
        message.tabId,
        () => store.sealAndRecover(
          message.tabId,
          identity,
          message.reason
        )
      ))
        .then((response) => sendResponse(
          response?.ok
            ? { ok: true, ...(response.sideEffect || {}) }
            : {
                ok: false,
                error: response?.error || 'ownership_proof_failed'
              }
        ))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    if (
      ![
        'BATCH_SAVE_SUBMIT_CONTEXT',
        'BATCH_GET_SUBMIT_CONTEXT',
        'BATCH_CLEAR_SUBMIT_CONTEXT'
      ].includes(message?.type)
    ) {
      return undefined;
    }
    if (!Number.isInteger(sender?.tab?.id)) {
      sendResponse({ ok: false, error: 'missing_sender_tab' });
      return false;
    }
    if (
      message.type === 'BATCH_SAVE_SUBMIT_CONTEXT'
      && !hasCompleteTaskIdentity(message.context)
    ) {
      sendResponse({
        ok: false,
        error: 'invalid_submit_context_identity'
      });
      return false;
    }
    if (
      message.type === 'BATCH_CLEAR_SUBMIT_CONTEXT'
      && (
        !message.match
        || typeof message.match.batchId !== 'string'
        || !Number.isInteger(message.match.urlIndex)
        || !Number.isInteger(message.match.attempt)
      )
    ) {
      sendResponse({
        ok: false,
        error: 'invalid_submit_context_match'
      });
      return false;
    }

    if (message.type === 'BATCH_GET_SUBMIT_CONTEXT') {
      Promise.resolve(store.get(sender.tab.id))
        .then((context) => sendResponse({ ok: true, context }))
        .catch((error) => sendResponse({
          ok: false,
          error: String(error)
        }));
      return true;
    }
    if (typeof runProofBoundTaskHook !== 'function') {
      sendResponse({
        ok: false,
        error: 'ownership_proof_unavailable'
      });
      return false;
    }
    const identity = taskIdentityOnly(
      message.type === 'BATCH_SAVE_SUBMIT_CONTEXT'
        ? message.context
        : message.match
    );
    const mutation = message.type === 'BATCH_SAVE_SUBMIT_CONTEXT'
      ? () => store.save(sender.tab.id, message.context)
      : () => store.clearIfMatches(sender.tab.id, message.match);
    Promise.resolve(runProofBoundTaskHook(
      identity,
      sender,
      mutation
    ))
      .then((response) => sendResponse(
        response?.ok
          ? { ok: true }
          : {
              ok: false,
              error: response?.error || 'ownership_proof_failed'
            }
      ))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  });
}
