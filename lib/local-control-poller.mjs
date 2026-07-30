import {
  LOCAL_DEBUG_BRIDGE_ORIGIN,
  LOCAL_DEBUG_BRIDGE_STORAGE_KEY
} from './local-debug-bridge.mjs';

export const LOCAL_CONTROL_ALARM = 'auto-comment-local-control-v1';
export const LOCAL_CONTROL_RESULTS_KEY = 'localControlCommandResultsV1';

const ALLOWED_COMMANDS = new Set([
  'status',
  'open',
  'start',
  'pause',
  'resume',
  'reconcile',
  'stop'
]);

function safeCode(error, fallback = 'local_control_failed') {
  const code = String(error?.code || error?.message || error || '');
  return /^[a-z0-9_:-]{1,80}$/i.test(code) ? code : fallback;
}

function validSettings(settings) {
  return settings?.enabled === true &&
    settings.origin === LOCAL_DEBUG_BRIDGE_ORIGIN &&
    typeof settings.token === 'string' &&
    settings.token.length >= 24;
}

async function readJson(response, fallback) {
  try {
    return await response.json();
  } catch (_) {
    throw Object.assign(new Error(fallback), { code: fallback });
  }
}

export function createLocalControlPoller({
  fetchImpl,
  runtime,
  storageArea,
  bridge,
  baseUrl = LOCAL_DEBUG_BRIDGE_ORIGIN,
  now = Date.now,
  maxCachedResults = 50
}) {
  let inFlight = null;

  async function readSettings() {
    const stored = await storageArea.get([LOCAL_DEBUG_BRIDGE_STORAGE_KEY]);
    const settings = stored[LOCAL_DEBUG_BRIDGE_STORAGE_KEY];
    return validSettings(settings) ? settings : null;
  }

  function authorization(token) {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
  }

  async function pair(settings) {
    const response = await fetchImpl(`${baseUrl}/api/v1/pair`, {
      method: 'POST',
      headers: authorization(settings.token),
      body: JSON.stringify({
        extensionId: runtime.id,
        token: settings.token
      })
    });
    if (!response.ok) {
      const body = await readJson(response, 'local_control_pair_failed');
      throw Object.assign(new Error(
        body?.error || 'local_control_pair_failed'
      ), {
        code: body?.error || 'local_control_pair_failed'
      });
    }
  }

  async function claimNext(settings) {
    const response = await fetchImpl(`${baseUrl}/api/v1/commands/next`, {
      method: 'GET',
      headers: authorization(settings.token)
    });
    if (response.status === 204) return null;
    if (!response.ok) {
      const body = await readJson(response, 'local_control_poll_failed');
      throw Object.assign(new Error(
        body?.error || 'local_control_poll_failed'
      ), {
        code: body?.error || 'local_control_poll_failed'
      });
    }
    const body = await readJson(response, 'local_control_command_invalid');
    const command = body?.command;
    if (
      typeof command?.id !== 'string' ||
      command.id.length === 0 ||
      command.id.length > 100 ||
      !ALLOWED_COMMANDS.has(command.command) ||
      (
        command.payload !== undefined &&
        (
          !command.payload ||
          typeof command.payload !== 'object' ||
          Array.isArray(command.payload)
        )
      )
    ) {
      throw Object.assign(new Error('local_control_command_invalid'), {
        code: 'local_control_command_invalid'
      });
    }
    return command;
  }

  async function cachedResult(commandId) {
    const stored = await storageArea.get([LOCAL_CONTROL_RESULTS_KEY]);
    return stored[LOCAL_CONTROL_RESULTS_KEY]?.[commandId]?.result || null;
  }

  async function rememberResult(commandId, result) {
    const stored = await storageArea.get([LOCAL_CONTROL_RESULTS_KEY]);
    const current = stored[LOCAL_CONTROL_RESULTS_KEY] || {};
    const entries = Object.entries(current)
      .filter(([id]) => id !== commandId)
      .sort((left, right) => (
        Number(right[1]?.completedAt) - Number(left[1]?.completedAt)
      ))
      .slice(0, Math.max(0, maxCachedResults - 1));
    await storageArea.set({
      [LOCAL_CONTROL_RESULTS_KEY]: Object.fromEntries([
        [
          commandId,
          {
            completedAt: now(),
            result
          }
        ],
        ...entries
      ])
    });
  }

  async function postResult(settings, commandId, result) {
    const response = await fetchImpl(
      `${baseUrl}/api/v1/commands/${encodeURIComponent(commandId)}/result`,
      {
        method: 'POST',
        headers: authorization(settings.token),
        body: JSON.stringify({ result })
      }
    );
    if (!response.ok) {
      const body = await readJson(response, 'local_control_result_failed');
      throw Object.assign(new Error(
        body?.error || 'local_control_result_failed'
      ), {
        code: body?.error || 'local_control_result_failed'
      });
    }
  }

  async function runOnce() {
    const settings = await readSettings();
    if (!settings) {
      return { ok: true, enabled: false, command: null };
    }
    await pair(settings);
    const command = await claimNext(settings);
    if (!command) {
      return { ok: true, enabled: true, command: null };
    }
    let result = await cachedResult(command.id);
    let replayed = true;
    if (!result) {
      replayed = false;
      result = await bridge.executeTrusted({
        command: command.command,
        requestId: command.id,
        ...(command.payload || {})
      });
      await rememberResult(command.id, result);
    }
    await postResult(settings, command.id, result);
    return {
      ok: true,
      enabled: true,
      command: command.command,
      commandId: command.id,
      replayed,
      result
    };
  }

  function pollOnce() {
    if (inFlight) return inFlight;
    inFlight = runOnce()
      .catch((error) => ({
        ok: false,
        error: safeCode(error)
      }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return { pollOnce };
}

export function installLocalControlPoller(chromeApi, dependencies) {
  const poller = createLocalControlPoller({
    fetchImpl: fetch,
    runtime: chromeApi.runtime,
    storageArea: chromeApi.storage.local,
    ...dependencies
  });
  const run = () => {
    void poller.pollOnce().catch(() => {});
  };
  const onAlarm = (alarm) => {
    if (alarm?.name === LOCAL_CONTROL_ALARM) run();
  };
  const onStorageChanged = (changes, areaName) => {
    if (
      areaName === 'local' &&
      Object.hasOwn(changes || {}, LOCAL_DEBUG_BRIDGE_STORAGE_KEY)
    ) {
      run();
    }
  };
  chromeApi.alarms.create(LOCAL_CONTROL_ALARM, {
    periodInMinutes: 0.5
  });
  chromeApi.alarms.onAlarm.addListener(onAlarm);
  chromeApi.storage.onChanged?.addListener(onStorageChanged);
  run();
  return {
    poller,
    dispose() {
      chromeApi.alarms.onAlarm.removeListener(onAlarm);
      chromeApi.storage.onChanged?.removeListener(onStorageChanged);
    }
  };
}
