const MESSAGE_TYPES = new Set([
  'PROFILE_SECRET_STATES',
  'PROFILE_SECRET_SET',
  'PROFILE_SECRET_CLEAR'
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isOptionsSender(sender, runtime) {
  if (sender?.id !== runtime.id) return false;
  try {
    const expected = new URL(runtime.getURL('options.html'));
    const actual = new URL(String(sender.url || ''));
    return actual.protocol === expected.protocol
      && actual.host === expected.host
      && actual.pathname === expected.pathname;
  } catch (_) {
    return false;
  }
}

export function createProfileSecretClient(runtime) {
  if (typeof runtime?.sendMessage !== 'function') {
    throw codedError('invalid_profile_secret_runtime');
  }

  async function request(message) {
    const response = await runtime.sendMessage(message);
    if (!response?.ok) {
      throw codedError(response?.error || 'profile_secret_request_failed');
    }
    return response;
  }

  return Object.freeze({
    async setPassword(profileId, password) {
      await request({ type: 'PROFILE_SECRET_SET', profileId, password });
    },
    async clearPassword(profileId) {
      await request({ type: 'PROFILE_SECRET_CLEAR', profileId });
    },
    async getConfiguredStates(profileIds) {
      const response = await request({
        type: 'PROFILE_SECRET_STATES',
        profileIds: structuredClone(profileIds)
      });
      if (
        !response.states
        || typeof response.states !== 'object'
        || Array.isArray(response.states)
        || Object.values(response.states).some(
          (configured) => typeof configured !== 'boolean'
        )
      ) {
        throw codedError('invalid_profile_secret_response');
      }
      return structuredClone(response.states);
    }
  });
}

export function installProfileSecretMessageListener(
  chromeApi,
  repository,
  { ready = Promise.resolve() } = {}
) {
  const listener = (message, sender, sendResponse) => {
    if (!MESSAGE_TYPES.has(message?.type)) return false;
    if (!isOptionsSender(sender, chromeApi.runtime)) {
      sendResponse({ ok: false, error: 'forbidden_sender' });
      return false;
    }
    Promise.resolve(ready)
      .then(async () => {
        switch (message.type) {
          case 'PROFILE_SECRET_STATES':
            return {
              ok: true,
              states: await repository.getConfiguredStates(message.profileIds)
            };
          case 'PROFILE_SECRET_SET':
            await repository.setPassword(message.profileId, message.password);
            return { ok: true };
          case 'PROFILE_SECRET_CLEAR':
            await repository.clearPassword(message.profileId);
            return { ok: true };
          default:
            return { ok: false, error: 'unsupported_message' };
        }
      })
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: typeof error?.code === 'string'
          ? error.code
          : 'profile_secret_request_failed'
      }));
    return true;
  };
  chromeApi.runtime.onMessage.addListener(listener);
  return listener;
}
