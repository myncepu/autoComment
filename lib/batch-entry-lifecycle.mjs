export function installBatchPageLifecycle({
  document: documentRef,
  pageTarget,
  boot
}) {
  const bootPromise = Promise.resolve().then(boot);
  let teardownPromise = null;

  const removeListeners = () => {
    pageTarget?.removeEventListener?.('pagehide', handlePageHide);
    documentRef?.removeEventListener?.('visibilitychange', handleVisibility);
  };
  const teardown = (reason = 'page_teardown') => {
    if (teardownPromise) return teardownPromise;
    teardownPromise = bootPromise
      .then((page) => page.destroy({ reason }))
      .finally(removeListeners);
    return teardownPromise;
  };
  const handlePageHide = () => {
    void teardown('page_teardown');
  };
  const handleVisibility = () => {
    if (documentRef?.visibilityState === 'hidden') {
      void teardown('page_teardown');
    }
  };

  pageTarget?.addEventListener?.('pagehide', handlePageHide);
  documentRef?.addEventListener?.('visibilitychange', handleVisibility);
  return {
    ready: bootPromise,
    destroy: teardown
  };
}
