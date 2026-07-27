export function createWorkerTabRemovalResult(task) {
  const uncertain = task?.state === 'submitting' ||
    task?.phase === 'submitting' ||
    task?.phase === 'confirming';
  return {
    result: uncertain ? 'manual_required' : 'fail',
    aiContent: null,
    errorCode: uncertain ? 'submission_uncertain' : 'task_failed',
    errorMessage: uncertain
      ? 'worker 标签页在提交确认期间被关闭'
      : '用户关闭了自动 worker 标签页'
  };
}
