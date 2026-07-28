const STORAGE_KEY = 'batchSubmitContextsByTab';
const RECOVERY_KEY = 'batchSubmitRecoveriesByTask';
const RECOVERY_SEALS_KEY = 'batchSubmitRecoverySealsByTab';
const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SUBMIT_CONTEXT_MAX_AGE_MS = DAY_MS;
export const DEFAULT_SUBMIT_RECOVERY_MAX_AGE_MS = 7 * DAY_MS;
export const DEFAULT_SUBMIT_RECOVERY_SEAL_MAX_AGE_MS = DAY_MS;
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

export function createSubmitContextMatch(message) {
  return {
    ...taskIdentityOnly(message),
    historyRevision: message?.history?.historyRevision
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

function retentionWindow(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isExpired(timestamp, currentTime, maxAgeMs) {
  return !Number.isFinite(timestamp) ||
    currentTime - timestamp > maxAgeMs;
}

function pruneState(
  { contexts, recoveries, seals },
  currentTime,
  { contextMaxAgeMs, recoveryMaxAgeMs, sealMaxAgeMs }
) {
  const removed = {
    contexts: 0,
    recoveries: 0,
    seals: 0
  };
  for (const [key, context] of Object.entries(contexts)) {
    if (!isExpired(context?.timestamp, currentTime, contextMaxAgeMs)) {
      continue;
    }
    delete contexts[key];
    removed.contexts += 1;
  }
  for (const [key, recovery] of Object.entries(recoveries)) {
    if (!isExpired(recovery?.recoveredAt, currentTime, recoveryMaxAgeMs)) {
      continue;
    }
    delete recoveries[key];
    removed.recoveries += 1;
  }
  for (const [key, seal] of Object.entries(seals)) {
    if (!isExpired(seal?.sealedAt, currentTime, sealMaxAgeMs)) continue;
    delete seals[key];
    removed.seals += 1;
  }
  return removed;
}

function removedAnything(removed) {
  return Object.values(removed).some((count) => count > 0);
}

function hasMatchingRecovery(recoveries, tabId, expected) {
  return Object.values(recoveries).some((recovery) => (
    recovery?.sourceTabId === tabId &&
    contextsMatch(recovery, expected)
  ));
}

export function createBatchSubmitContextStore(
  storageArea,
  {
    now = Date.now,
    maxAgeMs = DEFAULT_SUBMIT_CONTEXT_MAX_AGE_MS,
    recoveryMaxAgeMs = DEFAULT_SUBMIT_RECOVERY_MAX_AGE_MS,
    sealMaxAgeMs = DEFAULT_SUBMIT_RECOVERY_SEAL_MAX_AGE_MS
  } = {}
) {
  let operation = Promise.resolve();
  const retention = {
    contextMaxAgeMs: retentionWindow(
      maxAgeMs,
      DEFAULT_SUBMIT_CONTEXT_MAX_AGE_MS
    ),
    recoveryMaxAgeMs: retentionWindow(
      recoveryMaxAgeMs,
      DEFAULT_SUBMIT_RECOVERY_MAX_AGE_MS
    ),
    sealMaxAgeMs: retentionWindow(
      sealMaxAgeMs,
      DEFAULT_SUBMIT_RECOVERY_SEAL_MAX_AGE_MS
    )
  };

  const enqueue = (work) => {
    const next = operation.then(work, work);
    operation = next.catch(() => {});
    return next;
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

  const writeRecoveryState = ({ contexts, recoveries, seals }) => (
    storageArea.set({
      [STORAGE_KEY]: contexts,
      [RECOVERY_KEY]: recoveries,
      [RECOVERY_SEALS_KEY]: seals
    })
  );

  const readPrunedState = async () => {
    const state = await readRecoveryState();
    const removed = pruneState(state, now(), retention);
    return { state, removed };
  };

  return {
    save(tabId, context) {
      return enqueue(async () => {
        const normalizedContext = normalizeTaskIdentity(context);
        const timestamp = now();
        const state = await readRecoveryState();
        pruneState(state, timestamp, retention);
        const { contexts, recoveries, seals } = state;
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
          await writeRecoveryState(state);
          return { recovered: true };
        }

        const contextKey = String(tabId);
        if (isStaleAttempt(contexts[contextKey], savedContext)) {
          throw new Error('stale_submit_context_attempt');
        }
        contexts[contextKey] = savedContext;
        await writeRecoveryState(state);
        return { recovered: false };
      });
    },

    get(tabId) {
      return enqueue(async () => {
        const { state, removed } = await readPrunedState();
        if (removedAnything(removed)) await writeRecoveryState(state);
        return state.contexts[String(tabId)] || null;
      });
    },

    clear(tabId) {
      return enqueue(async () => {
        const { state } = await readPrunedState();
        delete state.contexts[String(tabId)];
        await writeRecoveryState(state);
      });
    },

    hasMatching(tabId, expected) {
      return enqueue(async () => {
        const { state, removed } = await readPrunedState();
        if (removedAnything(removed)) await writeRecoveryState(state);
        return contextsMatch(state.contexts[String(tabId)], expected);
      });
    },

    clearIfMatches(tabId, expected) {
      return enqueue(async () => {
        const { state, removed } = await readPrunedState();
        const key = String(tabId);
        if (!contextsMatch(state.contexts[key], expected)) {
          if (removedAnything(removed)) await writeRecoveryState(state);
          return false;
        }

        delete state.contexts[key];
        await writeRecoveryState(state);
        return true;
      });
    },

    sealAndRecover(tabId, expected, reason = 'unknown') {
      return enqueue(async () => {
        const normalizedExpected = normalizeTaskIdentity(expected);
        const state = await readRecoveryState();
        const sealedAt = now();
        pruneState(state, sealedAt, retention);
        const { contexts, recoveries, seals } = state;
        const contextKey = String(tabId);
        const context = contexts[contextKey];
        let recovered = false;
        if (contextsMatch(context, normalizedExpected)) {
          putRecovery(recoveries, context, tabId, sealedAt, reason);
          delete contexts[contextKey];
          recovered = true;
        } else if (
          hasMatchingRecovery(recoveries, tabId, normalizedExpected)
        ) {
          recovered = true;
          delete seals[recoverySealKey(tabId, normalizedExpected)];
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
        await writeRecoveryState(state);
        return { sealed: true, recovered };
      });
    },

    pruneExpired() {
      return enqueue(async () => {
        const state = await readRecoveryState();
        const removed = pruneState(state, now(), retention);
        if (removedAnything(removed)) await writeRecoveryState(state);
        return removed;
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
