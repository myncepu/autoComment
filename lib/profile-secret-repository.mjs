export const PROFILE_SECRETS_KEY = 'autoCommentProfileSecrets';
export const PROFILE_SECRETS_VERSION = 1;

const EMPTY_STORE = Object.freeze({
  version: PROFILE_SECRETS_VERSION,
  passwordsByProfileId: Object.freeze({})
});

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function profileId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw codedError('invalid_profile_id');
  }
  return value.trim();
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function normalizeStore(value) {
  if (!exactKeys(value, ['version', 'passwordsByProfileId'])
      || value.version !== PROFILE_SECRETS_VERSION
      || !value.passwordsByProfileId
      || typeof value.passwordsByProfileId !== 'object'
      || Array.isArray(value.passwordsByProfileId)) {
    throw codedError('invalid_profile_secret_store');
  }

  const passwordsByProfileId = {};
  for (const [rawId, password] of Object.entries(value.passwordsByProfileId)) {
    let id;
    try {
      id = profileId(rawId);
    } catch {
      throw codedError('invalid_profile_secret_store');
    }
    if (id !== rawId || typeof password !== 'string' || password === '') {
      throw codedError('invalid_profile_secret_store');
    }
    passwordsByProfileId[id] = password;
  }
  return {
    version: PROFILE_SECRETS_VERSION,
    passwordsByProfileId
  };
}

export function createProfileSecretRepository(storageArea) {
  if (!storageArea?.get || !storageArea?.set) {
    throw codedError('invalid_profile_secret_storage');
  }

  let operation = Promise.resolve();

  async function readStore() {
    const stored = await storageArea.get([PROFILE_SECRETS_KEY]);
    return Object.hasOwn(stored, PROFILE_SECRETS_KEY)
      ? normalizeStore(stored[PROFILE_SECRETS_KEY])
      : structuredClone(EMPTY_STORE);
  }

  function enqueue(work) {
    const next = operation.then(work, work);
    operation = next.catch(() => {});
    return next;
  }

  async function writePassword(rawProfileId, password) {
    const id = profileId(rawProfileId);
    if (typeof password !== 'string') throw codedError('invalid_profile_password');
    const store = await readStore();
    if (password === '') {
      delete store.passwordsByProfileId[id];
    } else {
      store.passwordsByProfileId[id] = password;
    }
    await storageArea.set({ [PROFILE_SECRETS_KEY]: structuredClone(store) });
  }

  function setPassword(rawProfileId, password) {
    return enqueue(() => writePassword(rawProfileId, password));
  }

  function clearPassword(rawProfileId) {
    return enqueue(() => writePassword(rawProfileId, ''));
  }

  async function getPasswordForBackground(rawProfileId) {
    const id = profileId(rawProfileId);
    await operation;
    const store = await readStore();
    return store.passwordsByProfileId[id];
  }

  async function getConfiguredStates(rawProfileIds) {
    if (!Array.isArray(rawProfileIds)) throw codedError('invalid_profile_ids');
    const ids = rawProfileIds.map(profileId);
    await operation;
    const store = await readStore();
    return Object.fromEntries(ids.map((id) => [
      id,
      Object.hasOwn(store.passwordsByProfileId, id)
    ]));
  }

  return {
    setPassword,
    clearPassword,
    getPasswordForBackground,
    getConfiguredStates
  };
}
