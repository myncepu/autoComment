export const LOCAL_DEBUG_BRIDGE_STORAGE_KEY = 'localDebugBridgeV1';
export const LOCAL_DEBUG_BRIDGE_ORIGIN = 'http://127.0.0.1:4376';
export const LOCAL_DEBUG_BRIDGE_REQUEST = 'LOCAL_DEBUG_BRIDGE_REQUEST';
export const LOCAL_DEBUG_PAGE_COMMAND = 'LOCAL_DEBUG_PAGE_COMMAND';

const ALLOWED_COMMANDS = new Set([
  'status',
  'pause',
  'resume',
  'reconcile'
]);

function safeCode(error, fallback = 'local_debug_bridge_failed') {
  const code = String(error?.code || error?.message || error || '');
  return /^[a-z0-9_:-]{1,80}$/i.test(code) ? code : fallback;
}

function trustedLocalSender(sender) {
  try {
    return new URL(sender?.url || '').origin === LOCAL_DEBUG_BRIDGE_ORIGIN;
  } catch (_) {
    return false;
  }
}

function tokensMatch(expected, supplied) {
  if (
    typeof expected !== 'string' ||
    typeof supplied !== 'string' ||
    expected.length < 24 ||
    expected.length !== supplied.length
  ) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return mismatch === 0;
}

function summarizeCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  const taskCounts = {};
  for (const task of Object.values(checkpoint.tasks || {})) {
    const state = typeof task?.state === 'string' ? task.state : 'unknown';
    taskCounts[state] = (taskCounts[state] || 0) + 1;
  }
  const resultCounts = {};
  for (const result of checkpoint.results || []) {
    const kind = typeof result?.result === 'string'
      ? result.result
      : 'unknown';
    resultCounts[kind] = (resultCounts[kind] || 0) + 1;
  }
  return {
    batchId: checkpoint.batchId || null,
    status: checkpoint.status || null,
    updatedAt: Number.isFinite(checkpoint.updatedAt)
      ? checkpoint.updatedAt
      : null,
    total: Array.isArray(checkpoint.source?.parsedUrls)
      ? checkpoint.source.parsedUrls.length
      : 0,
    taskCounts,
    resultCounts,
    timeoutSeconds: Number(checkpoint.settings?.timeoutSeconds) || null,
    concurrency: Number(checkpoint.settings?.concurrency) || null
  };
}

async function withTimeout(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('local_debug_page_timeout');
          error.code = 'local_debug_page_timeout';
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function createLocalDebugBridge({
  runtime,
  storageArea,
  batchRuntimeController,
  now = Date.now,
  pageTimeoutMs = 30000
}) {
  async function authorize(message, sender) {
    if (!trustedLocalSender(sender)) {
      throw Object.assign(new Error('local_debug_origin_forbidden'), {
        code: 'local_debug_origin_forbidden'
      });
    }
    const stored = await storageArea.get([LOCAL_DEBUG_BRIDGE_STORAGE_KEY]);
    const settings = stored[LOCAL_DEBUG_BRIDGE_STORAGE_KEY];
    if (
      settings?.enabled !== true ||
      settings.origin !== LOCAL_DEBUG_BRIDGE_ORIGIN ||
      !tokensMatch(settings.token, message?.token)
    ) {
      throw Object.assign(new Error('local_debug_unauthorized'), {
        code: 'local_debug_unauthorized'
      });
    }
  }

  async function backgroundStatus() {
    const response = await batchRuntimeController.handleMessage({
      type: 'BATCH_SESSION_GET'
    });
    if (!response?.ok) {
      throw Object.assign(new Error(response?.error || 'batch_status_failed'), {
        code: response?.error || 'batch_status_failed'
      });
    }
    return summarizeCheckpoint(response.checkpoint);
  }

  async function sendPageCommand(command, requestId) {
    return withTimeout(runtime.sendMessage({
      type: LOCAL_DEBUG_PAGE_COMMAND,
      command,
      requestId
    }), pageTimeoutMs);
  }

  async function handle(message, sender) {
    if (message?.type !== LOCAL_DEBUG_BRIDGE_REQUEST) {
      return { ok: false, error: 'local_debug_message_unsupported' };
    }
    await authorize(message, sender);
    if (!ALLOWED_COMMANDS.has(message.command)) {
      return { ok: false, error: 'local_debug_command_forbidden' };
    }
    const requestId = typeof message.requestId === 'string'
      ? message.requestId.slice(0, 100)
      : `debug-${now()}`;
    const background = await backgroundStatus();
    if (message.command === 'status') {
      let page = null;
      let pageError = null;
      try {
        const response = await sendPageCommand('status', requestId);
        if (response?.ok) page = response.page || null;
        else pageError = response?.error || 'batch_page_unavailable';
      } catch (error) {
        pageError = safeCode(error, 'batch_page_unavailable');
      }
      return {
        ok: true,
        requestId,
        receivedAt: now(),
        background,
        page,
        pageError
      };
    }
    const response = await sendPageCommand(message.command, requestId);
    if (!response?.ok) {
      return {
        ok: false,
        requestId,
        error: response?.error || 'batch_page_command_failed',
        background
      };
    }
    return {
      ok: true,
      requestId,
      receivedAt: now(),
      command: message.command,
      background: await backgroundStatus(),
      page: response.page || null
    };
  }

  return {
    async handle(message, sender) {
      try {
        return await handle(message, sender);
      } catch (error) {
        return {
          ok: false,
          error: safeCode(error)
        };
      }
    }
  };
}

export function installLocalDebugBridge(chromeApi, dependencies) {
  const externalMessages = chromeApi.runtime?.onMessageExternal;
  if (typeof externalMessages?.addListener !== 'function') {
    return () => {};
  }
  const bridge = createLocalDebugBridge({
    runtime: chromeApi.runtime,
    storageArea: chromeApi.storage.local,
    ...dependencies
  });
  const listener = (message, sender, sendResponse) => {
    if (message?.type !== LOCAL_DEBUG_BRIDGE_REQUEST) return false;
    void bridge.handle(message, sender).then(sendResponse);
    return true;
  };
  externalMessages.addListener(listener);
  return () => externalMessages.removeListener?.(listener);
}
