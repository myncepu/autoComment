export const BATCH_SECRET_VAULTS_KEY = 'autoCommentBatchSecretVaults';
export const BATCH_SECRET_VAULT_VERSION = 1;

const REQUEST_KEYS = ['type', 'batchId', 'taskId', 'urlIndex', 'profileId'];
const ENTRY_KEYS = ['version', 'createdAt', 'passwordsByProfileId'];
const CLEARING_MESSAGE_TYPES = new Set([
  'BATCH_SESSION_COMPLETE',
  'BATCH_SESSION_STOP',
  'BATCH_SESSION_CLEAR'
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function identifier(value, code) {
  if (typeof value !== 'string' || value.trim() === '') throw codedError(code);
  return value.trim();
}

function normalizeEntry(value) {
  if (!exactKeys(value, ENTRY_KEYS)
      || value.version !== BATCH_SECRET_VAULT_VERSION
      || !Number.isInteger(value.createdAt)
      || value.createdAt < 0
      || !isRecord(value.passwordsByProfileId)) {
    throw codedError('invalid_batch_secret_vault');
  }
  const passwordsByProfileId = {};
  for (const [rawProfileId, password] of Object.entries(value.passwordsByProfileId)) {
    const profileId = identifier(rawProfileId, 'invalid_batch_secret_vault');
    if (profileId !== rawProfileId || typeof password !== 'string' || password === '') {
      throw codedError('invalid_batch_secret_vault');
    }
    passwordsByProfileId[profileId] = password;
  }
  return {
    version: BATCH_SECRET_VAULT_VERSION,
    createdAt: value.createdAt,
    passwordsByProfileId
  };
}

function normalizeVaults(value) {
  if (!isRecord(value)) throw codedError('invalid_batch_secret_vault');
  return Object.fromEntries(Object.entries(value).map(([rawBatchId, entry]) => {
    const batchId = identifier(rawBatchId, 'invalid_batch_secret_vault');
    if (batchId !== rawBatchId) throw codedError('invalid_batch_secret_vault');
    return [batchId, normalizeEntry(entry)];
  }));
}

function resolvedNow(now) {
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isInteger(value) || value < 0) {
    throw codedError('invalid_batch_secret_time');
  }
  return value;
}

export function createBatchSecretVaultStore(
  storageArea,
  { now = Date.now } = {}
) {
  if (!storageArea?.get || !storageArea?.set) {
    throw codedError('invalid_batch_secret_storage');
  }
  let operation = Promise.resolve();

  async function readVaults() {
    const stored = await storageArea.get([BATCH_SECRET_VAULTS_KEY]);
    if (!Object.hasOwn(stored, BATCH_SECRET_VAULTS_KEY)) return {};
    return normalizeVaults(stored[BATCH_SECRET_VAULTS_KEY]);
  }

  function enqueue(work) {
    const next = operation.then(work, work);
    operation = next.catch(() => {});
    return next;
  }

  async function buildPreparedEntry(batchIdValue, profileIds, profileSecretRepository) {
    identifier(batchIdValue, 'invalid_batch_id');
    if (!Array.isArray(profileIds)
        || typeof profileSecretRepository?.getPasswordForBackground !== 'function') {
      throw codedError('invalid_batch_secret_input');
    }
    const uniqueProfileIds = [...new Set(profileIds.map((value) => (
      identifier(value, 'invalid_profile_id')
    )))];
    const passwordsByProfileId = {};
    for (const profileId of uniqueProfileIds) {
      const password = await profileSecretRepository.getPasswordForBackground(profileId);
      if (password !== undefined && password !== null && password !== '') {
        if (typeof password !== 'string') throw codedError('invalid_profile_password');
        passwordsByProfileId[profileId] = password;
      }
    }
    return {
      version: BATCH_SECRET_VAULT_VERSION,
      createdAt: resolvedNow(now),
      passwordsByProfileId
    };
  }

  async function buildStoragePatch(batchIdValue, entryValue) {
    const batchId = identifier(batchIdValue, 'invalid_batch_id');
    const entry = normalizeEntry(entryValue);
    await operation;
    const vaults = await readVaults();
    vaults[batchId] = entry;
    return {
      [BATCH_SECRET_VAULTS_KEY]: structuredClone(vaults)
    };
  }

  async function getAuthorizedPassword({
    request,
    senderTabId,
    checkpoint
  }) {
    try {
      if (!exactKeys(request, REQUEST_KEYS)
          || request.type !== 'BATCH_GET_TASK_PASSWORD'
          || !Number.isInteger(request.urlIndex)
          || request.urlIndex < 0
          || !Number.isInteger(senderTabId)
          || checkpoint?.version !== 3
          || checkpoint.status !== 'running'
          || identifier(request.batchId, 'forbidden_task_secret') !== checkpoint.batchId) {
        throw codedError('forbidden_task_secret');
      }
      const task = checkpoint.tasks?.[String(request.urlIndex)];
      if (!task
          || identifier(request.taskId, 'forbidden_task_secret') !== task.taskId
          || task.urlIndex !== request.urlIndex
          || !['active', 'submitting'].includes(task.state)
          || task.tabId !== senderTabId
          || identifier(request.profileId, 'forbidden_task_secret') !== task.profileId) {
        throw codedError('forbidden_task_secret');
      }

      await operation;
      const vaults = await readVaults();
      const password = vaults[request.batchId]
        ?.passwordsByProfileId?.[request.profileId];
      return { password: typeof password === 'string' ? password : null };
    } catch {
      throw codedError('forbidden_task_secret');
    }
  }

  function clear(batchIdValue) {
    return enqueue(async () => {
      const batchId = identifier(batchIdValue, 'invalid_batch_id');
      const vaults = await readVaults();
      if (!Object.hasOwn(vaults, batchId)) return { removed: false };
      delete vaults[batchId];
      await storageArea.set({
        [BATCH_SECRET_VAULTS_KEY]: structuredClone(vaults)
      });
      return { removed: true };
    });
  }

  function cleanupOrphans(checkpoint) {
    return enqueue(async () => {
      const vaults = await readVaults();
      const retainedBatchId = checkpoint?.version === 3
        && ['running', 'paused_recovery'].includes(checkpoint.status)
        && typeof checkpoint.batchId === 'string'
        ? checkpoint.batchId
        : null;
      const retainedBatchIds = retainedBatchId
        && Object.hasOwn(vaults, retainedBatchId)
        ? [retainedBatchId]
        : [];
      const removedBatchIds = Object.keys(vaults)
        .filter((batchId) => batchId !== retainedBatchId)
        .sort();
      if (removedBatchIds.length > 0) {
        const retained = retainedBatchIds.length > 0
          ? { [retainedBatchId]: vaults[retainedBatchId] }
          : {};
        await storageArea.set({
          [BATCH_SECRET_VAULTS_KEY]: structuredClone(retained)
        });
      }
      return { removedBatchIds, retainedBatchIds };
    });
  }

  return {
    buildPreparedEntry,
    buildStoragePatch,
    getAuthorizedPassword,
    clear,
    cleanupOrphans
  };
}

export function createBatchSecretAwareRuntimeController(controller, vaultStore) {
  if (!controller?.handleMessage
      || !controller?.recoverOnStartup
      || !vaultStore?.clear
      || !vaultStore?.cleanupOrphans) {
    throw codedError('invalid_batch_secret_runtime');
  }
  return {
    ...controller,
    async handleMessage(message, ...args) {
      const response = await controller.handleMessage(message, ...args);
      if (response?.ok && CLEARING_MESSAGE_TYPES.has(message?.type)) {
        try {
          await vaultStore.clear(message.batchId);
        } catch {
          return {
            ok: false,
            error: 'batch_secret_cleanup_failed',
            checkpoint: response.checkpoint
          };
        }
      }
      return response;
    },
    async recoverOnStartup(...args) {
      const response = await controller.recoverOnStartup(...args);
      if (!response?.ok) return response;
      try {
        await vaultStore.cleanupOrphans(response.checkpoint);
      } catch {
        return {
          ok: false,
          error: 'batch_secret_cleanup_failed',
          checkpoint: response.checkpoint
        };
      }
      return response;
    }
  };
}

export function installBatchSecretVaultListener(
  chromeApi,
  { vaultStore, checkpointReader }
) {
  if (!chromeApi?.runtime?.onMessage?.addListener
      || !vaultStore?.getAuthorizedPassword
      || typeof checkpointReader !== 'function') {
    throw codedError('invalid_batch_secret_listener');
  }
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'BATCH_GET_TASK_PASSWORD') return false;
    if (sender?.id !== chromeApi.runtime.id || !Number.isInteger(sender?.tab?.id)) {
      sendResponse({ ok: false, error: 'forbidden_task_secret' });
      return false;
    }
    (async () => {
      try {
        const checkpoint = await checkpointReader();
        const result = await vaultStore.getAuthorizedPassword({
          request: message,
          senderTabId: sender.tab.id,
          checkpoint
        });
        sendResponse({ ok: true, password: result.password });
      } catch {
        sendResponse({ ok: false, error: 'forbidden_task_secret' });
      }
    })();
    return true;
  });
}
