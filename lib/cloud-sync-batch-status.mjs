const CLOUD_QUEUE_STATUSES = new Set([
  'failed',
  'queued',
  'synced'
]);

export function cloudQueueStatusFields(cloudQueueStatus) {
  return CLOUD_QUEUE_STATUSES.has(cloudQueueStatus)
    ? { cloudQueueStatus }
    : {};
}

export function renderCloudQueueStatus(result, elements) {
  const warning = elements?.cloudSyncBatchWarning;
  if (!warning) return;
  const failed = (
    result?.result === 'success'
    && result?.historySaveStatus === 'saved'
    && result?.cloudQueueStatus === 'failed'
  );
  warning.textContent = failed
    ? '评论已保存，尚未进入云同步队列。'
    : '';
  warning.hidden = !failed;
}
