function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function createRetryableReadiness(initializer) {
  if (typeof initializer !== 'function') {
    throw codedError('invalid_readiness_initializer');
  }
  let completed = false;
  let completedValue;
  let pending = null;

  return function ensureReady() {
    if (completed) return Promise.resolve(completedValue);
    if (pending) return pending;
    pending = Promise.resolve()
      .then(initializer)
      .then(
        (value) => {
          completed = true;
          completedValue = value;
          pending = null;
          return value;
        },
        (error) => {
          pending = null;
          throw error;
        }
      );
    return pending;
  };
}

export function awaitReadiness(ready) {
  return Promise.resolve().then(() => (
    typeof ready === 'function' ? ready() : ready
  ));
}

export function createInitializationAwareBatchRuntimeController(
  controller,
  ensureReady
) {
  if (
    !controller
    || typeof ensureReady !== 'function'
    || typeof controller.handleMessage !== 'function'
    || typeof controller.handleWorkerTabRemoved !== 'function'
    || typeof controller.recoverOnStartup !== 'function'
  ) {
    throw codedError('invalid_initialization_aware_batch_runtime');
  }

  const wrapped = { ...controller };
  for (const method of [
    'handleMessage',
    'handleWorkerTabRemoved',
    'loadForPage',
    'markTerminal',
    'recoverOnStartup',
    'runProofBoundTaskHook',
    'runOwnerPageRecoveryHook'
  ]) {
    if (typeof controller[method] !== 'function') continue;
    wrapped[method] = async (...args) => {
      await ensureReady();
      return controller[method](...args);
    };
  }
  return wrapped;
}
