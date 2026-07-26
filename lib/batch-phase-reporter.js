(function installBatchPhaseReporter(globalObject) {
  const allowed = new Set([
    'opening',
    'loading',
    'detecting',
    'generating',
    'filling',
    'submitting',
    'confirming',
    'closing'
  ]);

  async function report(runtime, context, phase) {
    if (!allowed.has(phase)) throw new Error('invalid_batch_phase');
    if (
      !context
      || typeof context.batchId !== 'string'
      || !Number.isInteger(context.urlIndex)
      || !Number.isInteger(context.attempt)
    ) {
      throw new Error('invalid_batch_identity');
    }
    return runtime.sendMessage({
      type: 'BATCH_TASK_PHASE',
      batchId: context.batchId,
      urlIndex: context.urlIndex,
      attempt: context.attempt,
      phase
    });
  }

  globalObject.AutoCommentBatchPhaseReporter = Object.freeze({ report });
})(globalThis);
