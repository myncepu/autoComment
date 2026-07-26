export function installBatchPageLifecycle({
  pageTarget,
  boot,
  requestPageTeardown
}) {
  const bootPromise = Promise.resolve().then(boot);
  let teardownPromise = null;
  let pagehidePromise = null;

  const removeListeners = () => {
    pageTarget?.removeEventListener?.('pagehide', handlePageHide);
  };
  const teardown = (reason = 'page_teardown') => {
    if (teardownPromise) return teardownPromise;
    teardownPromise = bootPromise
      .then((page) => page.destroy({ reason }))
      .finally(removeListeners);
    return teardownPromise;
  };
  const handlePageHide = () => {
    if (pagehidePromise || typeof requestPageTeardown !== 'function') return;
    try {
      pagehidePromise = Promise.resolve(
        requestPageTeardown({ reason: 'pagehide' })
      ).catch(() => {});
    } catch (_) {
      pagehidePromise = Promise.resolve();
    }
  };
  pageTarget?.addEventListener?.('pagehide', handlePageHide);
  return {
    ready: bootPromise,
    destroy: teardown
  };
}
