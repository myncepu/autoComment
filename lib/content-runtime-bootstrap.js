(function installContentRuntimeBootstrap(scope) {
  const existing = scope.AutoCommentContentRuntimeBootstrap;
  if (
    existing?.bootstrapReady === true
    && typeof existing.markRuntimeReady === 'function'
  ) {
    return;
  }

  const onMessage = scope.chrome?.runtime?.onMessage;
  if (typeof onMessage?.addListener !== 'function') return;

  const state = { runtimeReady: false };

  function documentUrl() {
    return typeof scope.location?.href === 'string'
      ? scope.location.href
      : '';
  }

  function readyState() {
    return typeof scope.document?.readyState === 'string'
      ? scope.document.readyState
      : 'unknown';
  }

  function snapshot() {
    return {
      bootstrapReady: true,
      runtimeReady: state.runtimeReady,
      documentUrl: documentUrl(),
      readyState: readyState()
    };
  }

  function handleMessage(message, _sender, sendResponse) {
    if (message?.type !== 'PING') return false;
    const status = snapshot();
    sendResponse(status.runtimeReady
      ? { ok: true, ...status }
      : {
          ok: false,
          error: 'content_runtime_initializing',
          ...status
        });
    return false;
  }

  const api = Object.freeze({
    get bootstrapReady() {
      return true;
    },
    get runtimeReady() {
      return state.runtimeReady;
    },
    markRuntimeReady() {
      state.runtimeReady = true;
      return snapshot();
    }
  });

  onMessage.addListener(handleMessage);
  Object.defineProperty(scope, 'AutoCommentContentRuntimeBootstrap', {
    value: api,
    configurable: false,
    enumerable: false,
    writable: false
  });
})(globalThis);
