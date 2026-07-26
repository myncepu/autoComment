import { assertNoSensitiveFields } from './domain-config-schema.mjs';

export function installBatchDomainConfigListener(
  chromeApi,
  domainConfigRepository
) {
  chromeApi.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {
      if (message?.type !== 'BATCH_GET_MANUAL_DEFAULT_CONFIG') {
        return undefined;
      }
      if (
        sender?.id !== chromeApi.runtime.id
        || !Number.isInteger(sender?.tab?.id)
      ) {
        sendResponse({ ok: false, error: 'forbidden_sender' });
        return false;
      }
      Promise.resolve(domainConfigRepository.load())
        .then((config) => {
          assertNoSensitiveFields(config);
          sendResponse({
            ok: true,
            config: structuredClone(config)
          });
        })
        .catch(() => {
          sendResponse({
            ok: false,
            error: 'manual_default_config_unavailable'
          });
        });
      return true;
    }
  );
}
