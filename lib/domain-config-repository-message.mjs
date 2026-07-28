import { validateDomainConfig } from './domain-config-schema.mjs';
import { awaitReadiness } from './retryable-readiness.mjs';

const REQUEST_TYPE = 'DOMAIN_CONFIG_REPOSITORY_REQUEST';
const OPERATIONS = new Map([
  ['load', 0],
  ['replace', 1],
  ['replaceIfRevision', 2],
  ['saveProfile', 1],
  ['deleteProfile', 1],
  ['savePromotionSite', 1],
  ['deletePromotionSite', 1],
  ['saveAssignmentPolicy', 1]
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
  } catch {
    return false;
  }
}

function responseConfig(value) {
  const validation = validateDomainConfig(value);
  if (!validation.ok) throw codedError('invalid_domain_config_repository_response');
  return validation.value;
}

export function createDomainConfigRepositoryClient(runtime) {
  if (typeof runtime?.sendMessage !== 'function') {
    throw codedError('invalid_domain_config_repository_runtime');
  }

  async function request(operation, args) {
    const response = await runtime.sendMessage({
      type: REQUEST_TYPE,
      operation,
      args: structuredClone(args)
    });
    if (!response?.ok) {
      throw codedError(response?.error || 'domain_config_repository_request_failed');
    }
    return responseConfig(response.config);
  }

  return Object.freeze({
    load: () => request('load', []),
    replace: (value) => request('replace', [value]),
    replaceIfRevision: (expectedRevision, value) => (
      request('replaceIfRevision', [expectedRevision, value])
    ),
    saveProfile: (profile) => request('saveProfile', [profile]),
    deleteProfile: (profileId) => request('deleteProfile', [profileId]),
    savePromotionSite: (site) => request('savePromotionSite', [site]),
    deletePromotionSite: (siteId) => request('deletePromotionSite', [siteId]),
    saveAssignmentPolicy: (policy) => request('saveAssignmentPolicy', [policy])
  });
}

export function installDomainConfigRepositoryMessageListener(
  chromeApi,
  repository,
  { ready = Promise.resolve() } = {}
) {
  const listener = (message, sender, sendResponse) => {
    if (message?.type !== REQUEST_TYPE) return false;
    if (!isOptionsSender(sender, chromeApi.runtime)) {
      sendResponse({ ok: false, error: 'forbidden_sender' });
      return false;
    }
    const expectedArity = OPERATIONS.get(message.operation);
    if (!Number.isInteger(expectedArity)
        || !Array.isArray(message.args)
        || message.args.length !== expectedArity
        || typeof repository?.[message.operation] !== 'function') {
      sendResponse({
        ok: false,
        error: 'invalid_domain_config_repository_request'
      });
      return false;
    }

    awaitReadiness(ready)
      .then(() => repository[message.operation](...structuredClone(message.args)))
      .then((config) => sendResponse({
        ok: true,
        config: responseConfig(config)
      }))
      .catch((error) => sendResponse({
        ok: false,
        error: typeof error?.code === 'string'
          ? error.code
          : 'domain_config_repository_request_failed'
      }));
    return true;
  };
  chromeApi.runtime.onMessage.addListener(listener);
  return listener;
}
