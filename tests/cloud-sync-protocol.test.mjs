import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCommentRevision,
  normalizeSyncMutation,
  pickCloudSyncSettings
} from '../lib/cloud-sync-protocol.mjs';

test('keeps only the approved non-sensitive setting keys', () => {
  assert.deepEqual(pickCloudSyncSettings({
    promotion_website_url: 'https://promo.test',
    promotion_website_content: 'description',
    auto_fill_user_name: 'CloudHu',
    auto_fill_user_email: 'owner@example.test',
    llm_api_base_url: 'https://openrouter.ai/api/v1',
    llm_model: 'qwen/qwen-plus',
    show_export_outlinks_floating_button: false,
    batch_checkbox_settings: { autoOpenPanel: true },
    batch_concurrency: 3,
    batch_timeout_seconds: 60,
    auto_comment_user_id: 'public-user',
    auto_fill_user_password: 'must-not-leave',
    llm_api_key: 'sk-secret',
    batch_urls: ['https://target.test']
  }), {
    promotion_website_url: 'https://promo.test',
    promotion_website_content: 'description',
    auto_fill_user_name: 'CloudHu',
    auto_fill_user_email: 'owner@example.test',
    llm_api_base_url: 'https://openrouter.ai/api/v1',
    llm_model: 'qwen/qwen-plus',
    show_export_outlinks_floating_button: false,
    batch_checkbox_settings: { autoOpenPanel: true },
    batch_concurrency: 3,
    batch_timeout_seconds: 60,
    auto_comment_user_id: 'public-user'
  });
});

test('rejects nested sensitive values from an otherwise allowed setting', () => {
  assert.throws(
    () => pickCloudSyncSettings({
      batch_checkbox_settings: { password: 'must-not-leave' }
    }),
    /SENSITIVE_FIELD_NOT_SYNCABLE/
  );
});

test('rejects a setting mutation for a non-whitelisted key', () => {
  assert.throws(
    () => normalizeSyncMutation({
      mutationId: 'mutation-a',
      entityType: 'setting',
      entityId: 'auto_fill_user_password',
      operation: 'upsert',
      payload: { value: 'secret' },
      createdAt: 1721000000000
    }),
    /SETTING_NOT_SYNCABLE/
  );
});

test('normalizes a legacy comment revision deterministically', () => {
  assert.deepEqual(normalizeCommentRevision({
    id: 'batch-a:1',
    submittedAt: 1721000000000
  }), {
    capturedAt: 1721000000000,
    recordedAt: 1721000000000,
    sequence: 0,
    id: 'legacy:batch-a:1:1721000000000'
  });
});

test('rejects recursively nested sensitive mutation fields', () => {
  assert.throws(
    () => normalizeSyncMutation({
      mutationId: 'mutation-a',
      entityType: 'comment',
      entityId: 'batch-a:1',
      operation: 'upsert',
      payload: {
        comment: { id: 'batch-a:1', nested: { authorization: 'Bearer secret' } },
        anchors: []
      },
      createdAt: 1721000000000
    }),
    /SENSITIVE_FIELD_NOT_SYNCABLE/
  );
});

test('rejects protected aliases nested in otherwise valid comment payloads', () => {
  for (const field of [
    'auto_fill_user_password',
    'api_key',
    'cookieValue',
    'page_credentials',
    'recovery_checkpoint',
    'batch_url_queue',
    'cloud_sync_secret'
  ]) {
    assert.throws(
      () => normalizeSyncMutation({
        mutationId: `mutation-${field}`,
        entityType: 'comment',
        entityId: 'batch-a:1',
        operation: 'upsert',
        payload: {
          comment: { id: 'batch-a:1', [field]: 'must-not-leave' },
          anchors: []
        },
        createdAt: 1721000000000
      }),
      /SENSITIVE_FIELD_NOT_SYNCABLE/
    );
  }
});

test('rejects payload properties outside the supported mutation variant', () => {
  assert.throws(
    () => normalizeSyncMutation({
      mutationId: 'setting-extra-payload',
      entityType: 'setting',
      entityId: 'batch_concurrency',
      operation: 'upsert',
      payload: { value: 3, wrapper: {} },
      createdAt: 1721000000000
    }),
    /UNKNOWN_MUTATION_PAYLOAD_KEY/
  );
});

test('rejects non-JSON setting values before they can be cloned', () => {
  for (const value of [
    new Map([['api_key', 'must-not-leave']]),
    new Set(['must-not-leave']),
    new Date(1721000000000)
  ]) {
    assert.throws(
      () => normalizeSyncMutation({
        mutationId: 'setting-non-json',
        entityType: 'setting',
        entityId: 'batch_checkbox_settings',
        operation: 'upsert',
        payload: { value },
        createdAt: 1721000000000
      }),
      /INVALID_MUTATION_PAYLOAD/
    );
  }
});

test('rejects sensitive API-key aliases nested in a setting value', () => {
  assert.throws(
    () => normalizeSyncMutation({
      mutationId: 'setting-api-key-suffix',
      entityType: 'setting',
      entityId: 'batch_checkbox_settings',
      operation: 'upsert',
      payload: { value: { api_key_value: 'must-not-leave' } },
      createdAt: 1721000000000
    }),
    /SENSITIVE_FIELD_NOT_SYNCABLE/
  );
});

test('normalizes only complete supported mutation variants', () => {
  const normalized = normalizeSyncMutation({
    mutationId: 'delete-a',
    entityType: 'comment_delete',
    entityId: 'batch-a:1',
    operation: 'delete',
    payload: { deletedAt: 1721000000000 },
    createdAt: 1721000000000
  });

  assert.deepEqual(normalized, {
    mutationId: 'delete-a',
    entityType: 'comment_delete',
    entityId: 'batch-a:1',
    operation: 'delete',
    payload: { deletedAt: 1721000000000 },
    createdAt: 1721000000000
  });
  assert.throws(
    () => normalizeSyncMutation({
      ...normalized,
      operation: 'upsert'
    }),
    /INVALID_MUTATION_OPERATION/
  );
});
