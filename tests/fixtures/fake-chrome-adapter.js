(function installLocalFixtureChrome(root) {
  const runtimeListeners = new Set();
  const storageListeners = new Set();
  const localData = {};
  const syncData = {
    show_export_outlinks_floating_button: false
  };
  const messages = [];
  const phases = [];
  const confirmations = [];
  const modelRequests = [];
  const passwordsByProfileId = new Map();
  let submitContext = null;
  let modelDelayMs = 0;
  let submittingDelayMs = 0;
  let currentHandle = null;

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function storageArea(data, areaName) {
    return {
      get(keys, callback) {
        const names = Array.isArray(keys)
          ? keys
          : typeof keys === 'string'
            ? [keys]
            : Object.keys(keys || {});
        const result = Object.fromEntries(names.flatMap((key) => (
          Object.hasOwn(data, key) ? [[key, clone(data[key])]] : []
        )));
        if (typeof callback === 'function') callback(result);
        return Promise.resolve(result);
      },
      set(values, callback) {
        const changes = {};
        for (const [key, value] of Object.entries(values || {})) {
          changes[key] = {
            oldValue: clone(data[key]),
            newValue: clone(value)
          };
          data[key] = clone(value);
        }
        for (const listener of storageListeners) listener(changes, areaName);
        if (typeof callback === 'function') callback();
        return Promise.resolve();
      },
      remove(keys, callback) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
        if (typeof callback === 'function') callback();
        return Promise.resolve();
      }
    };
  }

  async function sendMessage(message) {
    messages.push(clone(message));
    switch (message?.type) {
      case 'LLM_GENERATE_COPY': {
        modelRequests.push(clone(message.payload));
        if (modelDelayMs > 0) {
          await new Promise((resolve) => root.setTimeout(resolve, modelDelayMs));
        }
        const handle = currentHandle;
        return {
          success: true,
          text: `LOCAL_COMMENT ${handle.profileId} ${handle.promotionSiteId}`
        };
      }
      case 'BATCH_GET_TASK_PASSWORD':
        return {
          ok: true,
          password: passwordsByProfileId.get(message.profileId) ?? null
        };
      case 'BATCH_TASK_PHASE':
        phases.push(clone(message));
        return { ok: true };
      case 'BATCH_GET_SUBMIT_CONTEXT':
        try {
          submitContext ||= JSON.parse(
            root.sessionStorage.getItem('fixtureSubmitContext') || 'null'
          );
        } catch (_) {}
        return { ok: true, context: clone(submitContext) };
      case 'BATCH_SAVE_SUBMIT_CONTEXT':
        submitContext = clone(message.context);
        try {
          root.sessionStorage.setItem(
            'fixtureSubmitContext',
            JSON.stringify(submitContext)
          );
        } catch (_) {}
        return { ok: true };
      case 'BATCH_CLEAR_SUBMIT_CONTEXT':
        submitContext = null;
        try {
          root.sessionStorage.removeItem('fixtureSubmitContext');
        } catch (_) {}
        return { ok: true };
      case 'BATCH_HANDLE_CONFIRM':
      case 'BATCH_HISTORY_PENDING_FALLBACK':
        confirmations.push(clone(message));
        submitContext = null;
        try {
          root.sessionStorage.removeItem('fixtureSubmitContext');
        } catch (_) {}
        return {
          ok: true,
          historySaveStatus: 'saved',
          historyPendingCount: 0
        };
      case 'BATCH_TASK_SUBMITTING':
        if (submittingDelayMs > 0) {
          await new Promise(
            (resolve) => root.setTimeout(resolve, submittingDelayMs)
          );
        }
        return { ok: true };
      case 'BATCH_PERSIST_PENDING_RESULT':
      case 'BATCH_REPORT_RESULT':
        return { ok: true };
      case 'BATCH_GET_MANUAL_DEFAULT_CONFIG':
        return { ok: false, error: 'manual_default_not_used' };
      default:
        return { ok: true };
    }
  }

  async function dispatchHandle(handle) {
    currentHandle = clone(handle);
    let response = null;
    for (const listener of runtimeListeners) {
      response = await new Promise((resolve, reject) => {
        let settled = false;
        const sendResponse = (value) => {
          if (settled) return;
          settled = true;
          resolve(clone(value));
        };
        try {
          const asyncResponse = listener(clone(handle), {}, sendResponse);
          if (asyncResponse !== true && !settled) {
            settled = true;
            resolve(undefined);
          }
        } catch (error) {
          reject(error);
        }
      });
      if (response !== undefined) break;
    }
    return response;
  }

  const chromeApi = {
    runtime: {
      lastError: null,
      sendMessage,
      onMessage: {
        addListener(listener) {
          runtimeListeners.add(listener);
        },
        removeListener(listener) {
          runtimeListeners.delete(listener);
        }
      }
    },
    storage: {
      local: storageArea(localData, 'local'),
      sync: storageArea(syncData, 'sync'),
      onChanged: {
        addListener(listener) {
          storageListeners.add(listener);
        },
        removeListener(listener) {
          storageListeners.delete(listener);
        }
      }
    }
  };

  root.chrome = chromeApi;
  root.LocalFixtureChrome = {
    get currentHandle() {
      return clone(currentHandle);
    },
    configurePasswords(values) {
      passwordsByProfileId.clear();
      for (const [profileId, password] of Object.entries(values || {})) {
        passwordsByProfileId.set(profileId, String(password));
      }
    },
    configureFaults({ llmDelayMs = 0, submitDelayMs = 0 } = {}) {
      modelDelayMs = Math.max(0, Number(llmDelayMs) || 0);
      submittingDelayMs = Math.max(0, Number(submitDelayMs) || 0);
    },
    async seedSubmitContext(context) {
      submitContext = clone(context);
      try {
        root.sessionStorage.setItem(
          'fixtureSubmitContext',
          JSON.stringify(submitContext)
        );
      } catch (_) {}
    },
    dispatchHandle,
    safeState() {
      return clone({
        phases,
        confirmations,
        modelRequests,
        submitContextPresent: Boolean(submitContext),
        messages: messages.filter(({ type }) => type !== 'BATCH_SAVE_SUBMIT_CONTEXT')
      });
    }
  };
})(globalThis);
