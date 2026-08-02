import { assertNoSensitiveFields } from './domain-config-schema.mjs';
import { awaitReadiness } from './retryable-readiness.mjs';

export function installBatchDomainConfigListener(
  chromeApi,
  domainConfigRepository,
  { ready = Promise.resolve() } = {}
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
      awaitReadiness(ready)
        .then(() => domainConfigRepository.load())
        .then((config) => {
          assertNoSensitiveFields(config);
          sendResponse({
            ok: true,
            config: structuredClone(config)
          });
        })
        .catch((error) => {
          sendResponse({
            ok: false,
            error: typeof error?.code === 'string'
              ? error.code
              : 'manual_default_config_unavailable'
          });
        });
      return true;
    }
  );
}
