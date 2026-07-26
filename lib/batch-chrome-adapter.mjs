import { loadLlmConfig } from './llm-config.mjs';
import {
  hasUrlCredentials,
  sanitizeBatchUrl
} from './batch-url-sanitizer.mjs';

const BATCH_DRAFT_KEY = 'batchDraftV1';
const LEGACY_RESULTS_KEY = 'batchLocalResults';
const AUTOMATION_SETTINGS_KEY = 'batch_checkbox_settings';
const CONCURRENCY_KEY = 'batch_concurrency';
const TIMEOUT_KEY = 'batch_timeout_seconds';
const PROFILE_STORAGE_KEYS = Object.freeze({
  websiteUrl: 'promotion_website_url',
  websiteContent: 'promotion_website_content',
  userName: 'auto_fill_user_name',
  userEmail: 'auto_fill_user_email'
});
const PAGE_RUNTIME_MESSAGE_TYPES = new Set([
  'BATCH_CONFIRMED',
  'BATCH_TASK_PHASE_UPDATED'
]);
const SENSITIVE_KEY = /(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|credential)/i;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function requireApi(api, label) {
  if (!api) throw new Error(`batch_chrome_${label}_missing`);
  return api;
}

function isTrustedBackgroundSender(sender, runtime) {
  if (sender?.id !== runtime.id || sender?.tab) return false;
  if (sender.url == null || sender.url === '') return true;
  return typeof runtime.getURL === 'function' &&
    sender.url === runtime.getURL('background.js');
}

function scrubSensitive(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => scrubSensitive(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(
    ([childKey, childValue]) => {
      const scrubbed = scrubSensitive(childValue, childKey);
      return scrubbed === undefined ? [] : [[childKey, scrubbed]];
    }
  ));
}

function createDraftStorage(storageArea) {
  return {
    async get() {
      const stored = await storageArea.get([BATCH_DRAFT_KEY]);
      return scrubSensitive(stored[BATCH_DRAFT_KEY]) ?? null;
    },
    async set(draft) {
      await storageArea.set({ [BATCH_DRAFT_KEY]: scrubSensitive(draft) });
    },
    async remove() {
      await storageArea.remove([BATCH_DRAFT_KEY]);
    }
  };
}

function createManualWindows(windowsApi) {
  return {
    async open(rawUrl) {
      const url = sanitizeBatchUrl(rawUrl);
      if (!url || hasUrlCredentials(rawUrl)) {
        const error = new Error('batch_url_credentials_forbidden');
        error.code = 'batch_url_credentials_forbidden';
        throw error;
      }
      const created = await windowsApi.create({
        url,
        focused: true,
        type: 'normal'
      });
      if (!Number.isInteger(created?.id)) {
        const error = new Error('manual_window_create_failed');
        error.code = 'manual_window_create_failed';
        throw error;
      }
      return {
        windowId: created.id,
        tabId: Number.isInteger(created?.tabs?.[0]?.id)
          ? created.tabs[0].id
          : null,
        url,
        automation: false
      };
    },
    async close(handle) {
      if (!Number.isInteger(handle?.windowId)) return;
      await windowsApi.remove(handle.windowId);
    }
  };
}

export function createChromeBatchDependencies(chromeApi) {
  const runtime = requireApi(chromeApi?.runtime, 'runtime');
  const storage = requireApi(chromeApi?.storage, 'storage');
  const tabsApi = requireApi(chromeApi?.tabs, 'tabs');
  const windowsApi = requireApi(chromeApi?.windows, 'windows');
  const syncStorage = requireApi(storage.sync, 'storage_sync');
  const localStorage = requireApi(storage.local, 'storage_local');

  async function runtimeRequest(type, payload = {}) {
    return runtime.sendMessage({ type, ...payload });
  }

  const workerTabsApi = {
    onRemoved: tabsApi.onRemoved,
    onUpdated: tabsApi.onUpdated,
    async create(_details, identity) {
      if (
        typeof identity?.batchId !== 'string' ||
        !Number.isInteger(identity?.urlIndex) ||
        !Number.isInteger(identity?.attempt) ||
        (
          identity?.requestId !== undefined &&
          (
            typeof identity.requestId !== 'string' ||
            identity.requestId.length === 0
          )
        )
      ) {
        const error = new Error('invalid_worker_identity');
        error.code = 'invalid_worker_identity';
        throw error;
      }
      const requestId = identity.requestId ||
        `${identity.batchId}:${identity.urlIndex}:${identity.attempt}`;
      const payload = {
        batchId: identity.batchId,
        urlIndex: identity.urlIndex,
        attempt: identity.attempt,
        requestId
      };
      let response;
      try {
        response = await runtimeRequest(
          'BATCH_CREATE_WORKER_TAB',
          payload
        );
      } catch (_) {
        response = await runtimeRequest(
          'BATCH_CREATE_WORKER_TAB',
          payload
        );
      }
      if (!response?.ok) {
        const error = new Error(response?.error || 'tab_create_failed');
        error.code = response?.error || 'tab_create_failed';
        if (response?.recoveryRequired === true) {
          error.recoveryRequired = true;
          error.runtimeCheckpoint = response.checkpoint || null;
        }
        throw error;
      }
      if (
        !Number.isInteger(response.tab?.id) ||
        !Number.isInteger(response.tab?.windowId) ||
        typeof response.tab?.url !== 'string' ||
        response.checkpoint?.batchId !== identity.batchId
      ) {
        const error = new Error('tab_create_failed');
        error.code = 'tab_create_failed';
        throw error;
      }
      return {
        ...response.tab,
        backgroundCheckpointed: true,
        runtimeCheckpoint: response.checkpoint
      };
    },
    get: (...args) => tabsApi.get(...args),
    query: (...args) => tabsApi.query(...args),
    sendMessage: (...args) => tabsApi.sendMessage(...args),
    remove: (...args) => tabsApi.remove(...args),
    update: (...args) => tabsApi.update(...args)
  };

  function subscribeRuntimeMessages(listener) {
    const handleMessage = (message, sender) => {
      if (
        !isTrustedBackgroundSender(sender, runtime) ||
        !PAGE_RUNTIME_MESSAGE_TYPES.has(message?.type)
      ) {
        return false;
      }
      listener(message);
      return false;
    };
    runtime.onMessage.addListener(handleMessage);
    return () => runtime.onMessage.removeListener(handleMessage);
  }

  async function loadBatchSettings() {
    const keys = [
      ...Object.values(PROFILE_STORAGE_KEYS),
      AUTOMATION_SETTINGS_KEY,
      CONCURRENCY_KEY,
      TIMEOUT_KEY
    ];
    const values = await syncStorage.get(keys);
    const automation = values[AUTOMATION_SETTINGS_KEY] || {};
    return {
      userName: text(values[PROFILE_STORAGE_KEYS.userName]),
      userEmail: text(values[PROFILE_STORAGE_KEYS.userEmail]),
      websiteUrl: text(values[PROFILE_STORAGE_KEYS.websiteUrl]),
      websiteContent: text(values[PROFILE_STORAGE_KEYS.websiteContent]),
      autoOpenPanel: automation.autoOpenPanel === true,
      autoGenerate: automation.autoGenerate !== false,
      autoSubmit: automation.autoSubmit === true,
      concurrency: clampInteger(values[CONCURRENCY_KEY], 1, 10, 3),
      timeoutSeconds: clampInteger(values[TIMEOUT_KEY], 10, 600, 60)
    };
  }

  async function loadLegacyResults() {
    const values = await localStorage.get([LEGACY_RESULTS_KEY]);
    return scrubSensitive(values[LEGACY_RESULTS_KEY]) ?? null;
  }

  async function getConsoleWindowId() {
    const currentTab = await tabsApi.getCurrent();
    if (!Number.isInteger(currentTab?.windowId)) {
      const error = new Error('batch_console_window_missing');
      error.code = 'batch_console_window_missing';
      throw error;
    }
    return currentTab.windowId;
  }

  async function sealSubmitContext(activity, reason) {
    if (!Number.isInteger(activity?.tabId)) {
      return { sealed: false, recovered: false };
    }
    try {
      const response = await runtimeRequest('BATCH_RECOVER_SUBMIT_CONTEXT', {
        tabId: activity.tabId,
        batchId: activity.batchId,
        urlIndex: activity.urlIndex,
        attempt: activity.attempt,
        reason
      });
      return {
        sealed: response?.ok === true && response.sealed === true,
        recovered: response?.ok === true && response.recovered === true
      };
    } catch (_) {
      return { sealed: false, recovered: false };
    }
  }

  return {
    runtimeRequest,
    subscribeRuntimeMessages,
    tabsApi: workerTabsApi,
    getConsoleWindowId,
    manualWindows: createManualWindows(windowsApi),
    loadBatchSettings,
    loadLlmConfig: () => loadLlmConfig(storage),
    draftStorage: createDraftStorage(localStorage),
    loadLegacyResults,
    sealSubmitContext,
    retryPendingHistoryWrites: () => runtime.sendMessage({
      type: 'HISTORY_RETRY_PENDING'
    }),
    loadHistoryRetentionStatus: () => runtime.sendMessage({
      type: 'HISTORY_RETENTION_STATUS'
    })
  };
}
