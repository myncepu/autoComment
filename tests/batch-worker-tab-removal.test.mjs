import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWorkerTabRemovalResult
} from '../lib/batch-worker-tab-removal.mjs';

test('classifies a pre-submit worker close as a safe failure', () => {
  assert.deepEqual(createWorkerTabRemovalResult({
    state: 'active',
    phase: 'generating'
  }), {
    result: 'fail',
    aiContent: null,
    errorCode: 'task_failed',
    errorMessage: '用户关闭了自动 worker 标签页'
  });
});

test('classifies a submitting worker close as manual-required', () => {
  assert.deepEqual(createWorkerTabRemovalResult({
    state: 'submitting',
    phase: 'confirming'
  }), {
    result: 'manual_required',
    aiContent: null,
    errorCode: 'submission_uncertain',
    errorMessage: 'worker 标签页在提交确认期间被关闭'
  });
});
