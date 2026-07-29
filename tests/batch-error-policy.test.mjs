import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getBatchError,
  getBatchRetryPolicy
} from '../lib/batch-error-policy.mjs';

test('classifies safe, confirmed-risk, and blocked retries', () => {
  assert.equal(getBatchRetryPolicy({
    result: 'fail',
    errorCode: 'task_timeout'
  }), 'safe');
  assert.equal(getBatchRetryPolicy({
    result: 'manual_required',
    errorCode: 'submission_uncertain'
  }), 'confirm');
  assert.equal(getBatchRetryPolicy({
    result: 'success',
    errorCode: null
  }), 'blocked');
  assert.equal(getBatchRetryPolicy({
    result: 'blocked_illegal',
    errorCode: 'illegal_site'
  }), 'blocked');
  assert.equal(getBatchRetryPolicy({
    result: 'fail',
    errorCode: 'submission_rejected'
  }), 'blocked');
});

test('returns a safe structured timeout error without credentials', () => {
  assert.deepEqual(getBatchError('task_timeout', {
    phase: 'generating',
    elapsedMs: 61000,
    apiKey: 'must-not-leak'
  }), {
    code: 'task_timeout',
    message: '处理超时，worker 标签页已安全关闭',
    retryPolicy: 'safe',
    diagnostic: {
      phase: 'generating',
      elapsedMs: 61000
    }
  });
});

test('describes automatic creation failures as worker tab failures', () => {
  assert.deepEqual(getBatchError('window_create_failed'), {
    code: 'window_create_failed',
    message: '无法创建 worker 标签页',
    retryPolicy: 'safe',
    diagnostic: {}
  });
});
