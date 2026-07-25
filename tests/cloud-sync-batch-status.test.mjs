import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cloudQueueStatusFields,
  renderCloudQueueStatus
} from '../lib/cloud-sync-batch-status.mjs';
import { isDurableBatchConfirmation } from '../lib/batch-scheduler.mjs';

function createElements() {
  return {
    cloudSyncBatchWarning: {
      hidden: true,
      textContent: ''
    }
  };
}

test('failed cloud queue status renders a visible local-first warning', () => {
  const elements = createElements();

  renderCloudQueueStatus({
    result: 'success',
    historySaveStatus: 'saved',
    cloudQueueStatus: 'failed'
  }, elements);

  assert.equal(
    elements.cloudSyncBatchWarning.textContent,
    '评论已保存，尚未进入云同步队列。'
  );
  assert.equal(elements.cloudSyncBatchWarning.hidden, false);
});

test('queued and synced cloud states do not alter local durability', () => {
  for (const cloudQueueStatus of ['queued', 'synced']) {
    const elements = createElements();
    const confirmation = {
      type: 'BATCH_CONFIRMED',
      result: 'success',
      historySaveStatus: 'saved',
      cloudQueueStatus
    };

    renderCloudQueueStatus(confirmation, elements);

    assert.equal(elements.cloudSyncBatchWarning.hidden, true);
    assert.equal(elements.cloudSyncBatchWarning.textContent, '');
    assert.equal(isDurableBatchConfirmation(confirmation), true);
  }
  assert.equal(isDurableBatchConfirmation({
    result: 'success',
    historySaveStatus: 'failed',
    cloudQueueStatus: 'synced'
  }), false);
});

test('propagation copies only a recognized cloud queue status', () => {
  assert.deepEqual(cloudQueueStatusFields('failed'), {
    cloudQueueStatus: 'failed'
  });
  assert.deepEqual(cloudQueueStatusFields('queued'), {
    cloudQueueStatus: 'queued'
  });
  assert.deepEqual(cloudQueueStatusFields('synced'), {
    cloudQueueStatus: 'synced'
  });
  assert.deepEqual(cloudQueueStatusFields('not_enabled'), {});
  assert.deepEqual(cloudQueueStatusFields('not_needed'), {});
  assert.deepEqual(cloudQueueStatusFields('acsync_secret-value'), {});
  assert.deepEqual(cloudQueueStatusFields(undefined), {});
});
