import { createChromeBatchDependencies } from './lib/batch-chrome-adapter.mjs';
import { renderBatchBootFailure } from './lib/batch-entry-error-view.mjs';
import { installBatchPageLifecycle } from './lib/batch-entry-lifecycle.mjs';
import { bootBatchPage } from './lib/batch-page-composition.mjs';

export {
  bootBatchPage,
  createChromeBatchDependencies,
  installBatchPageLifecycle
};

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const showBootFailure = (error) => {
      console.error('[batch] boot failed:', error?.code || 'batch_boot_failed');
      renderBatchBootFailure(document, {
        code: error?.code || 'batch_boot_failed',
        onRetry: () => globalThis.location?.reload?.()
      });
    };
    try {
      const chromeDependencies = createChromeBatchDependencies(chrome);
      let pageTeardownContext = null;
      const runtimeRequest = async (type, payload) => {
        const previousContext = pageTeardownContext;
        const pendingStartBatchId =
          type === 'BATCH_SESSION_START' &&
          typeof payload?.batchId === 'string' &&
          payload.batchId.length > 0
            ? payload.batchId
            : null;
        if (pendingStartBatchId) {
          pageTeardownContext = { batchId: pendingStartBatchId };
        }
        try {
          const response =
            await chromeDependencies.runtimeRequest(type, payload);
          if (
            typeof response?.pageOwnership?.batchId === 'string' &&
            response.pageOwnership.batchId.length > 0
          ) {
            pageTeardownContext = {
              batchId: response.pageOwnership.batchId
            };
          } else if (pendingStartBatchId) {
            pageTeardownContext = previousContext;
          }
          return response;
        } catch (error) {
          if (pendingStartBatchId) pageTeardownContext = previousContext;
          throw error;
        }
      };
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
        getPageTeardownContext: () => pageTeardownContext,
        requestPageTeardown: (payload) => (
          chromeDependencies.runtimeRequest('BATCH_PAGE_TEARDOWN', payload)
        ),
        boot: () => bootBatchPage(document, {
          ...chromeDependencies,
          ...webDependencies,
          runtimeRequest
        })
      });
      void lifecycle.ready.catch(showBootFailure);
    } catch (error) {
      showBootFailure(error);
    }
  }, { once: true });
}
