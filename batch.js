import { createChromeBatchDependencies } from './lib/batch-chrome-adapter.mjs';
import { bootBatchPage } from './lib/batch-page-composition.mjs';

export { bootBatchPage, createChromeBatchDependencies };

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
    void bootBatchPage(document, {
      ...chromeDependencies,
      ...webDependencies
    }).catch((error) => {
      console.error('[batch] boot failed:', error?.code || 'batch_boot_failed');
    });
  }, { once: true });
}
