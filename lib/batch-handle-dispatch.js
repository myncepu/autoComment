((root) => {
  function create({
    accept,
    getKey,
    execute,
    onExecutionError = () => {},
    schedule = queueMicrotask
  }) {
    if (
      typeof accept !== 'function' ||
      typeof getKey !== 'function' ||
      typeof execute !== 'function' ||
      typeof schedule !== 'function'
    ) {
      throw new Error('invalid_batch_handle_dispatch');
    }
    const inFlight = new Set();

    function handleMessage(message, sendResponse) {
      if (message?.type !== 'BATCH_HANDLE') return false;

      let validation;
      try {
        validation = accept(message);
      } catch (error) {
        validation = {
          ok: false,
          error: error?.code || 'invalid_task_config',
          urlIndex: message?.urlIndex
        };
      }
      const taskConfig = validation?.taskConfig;
      if (!taskConfig) {
        sendResponse({
          ok: false,
          error: validation?.error || 'invalid_task_config',
          urlIndex: validation?.urlIndex ?? message?.urlIndex
        });
        return true;
      }

      const key = getKey(taskConfig);
      if (inFlight.has(key)) {
        sendResponse({
          ok: false,
          error: 'duplicate_batch_task_running',
          urlIndex: message.urlIndex
        });
        return true;
      }
      inFlight.add(key);
      sendResponse({
        ok: true,
        accepted: true,
        urlIndex: message.urlIndex
      });
      schedule(() => {
        Promise.resolve()
          .then(() => execute(taskConfig))
          .catch((error) => {
            try {
              onExecutionError(error, taskConfig);
            } catch (_) {}
          })
          .finally(() => {
            inFlight.delete(key);
          });
      });
      return true;
    }

    return Object.freeze({ handleMessage });
  }

  root.AutoCommentBatchHandleDispatch = Object.freeze({ create });
})(globalThis);
