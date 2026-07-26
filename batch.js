import { createChromeBatchDependencies } from './lib/batch-chrome-adapter.mjs';
import { installBatchPageLifecycle } from './lib/batch-entry-lifecycle.mjs';
import { bootBatchPage } from './lib/batch-page-composition.mjs';

export {
  bootBatchPage,
  createChromeBatchDependencies,
  installBatchPageLifecycle
};

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const chromeDependencies = createChromeBatchDependencies(chrome);
    const webDependencies = {
      parseCsv: (text, options) => globalThis.Papa.parse(text, options),
      evaluateUrl: (url, context) => (
        globalThis.AutoCommentIllegalSiteFilter?.evaluateUrl?.(url, context) ||
        { blocked: false }
      ),
      onlineTarget: globalThis,
      isOnline: () => globalThis.navigator?.onLine !== false
    };
    const lifecycle = installBatchPageLifecycle({
      document,
      pageTarget: globalThis,
      requestPageTeardown: ({ reason }) => (
        chromeDependencies.runtimeRequest('BATCH_PAGE_TEARDOWN', { reason })
      ),
      boot: () => bootBatchPage(document, {
        ...chromeDependencies,
        ...webDependencies
      })
    });
    void lifecycle.ready.catch((error) => {
      console.error('[batch] boot failed:', error?.code || 'batch_boot_failed');
    });
  }, { once: true });
}
