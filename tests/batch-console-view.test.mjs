import assert from 'node:assert/strict';
import test from 'node:test';

import { createBatchConsoleView } from '../lib/batch-console-view.mjs';
import {
  change,
  click,
  consoleDocument,
  consoleHandlers,
  emptySnapshotFixture,
  errorSnapshotFixture,
  offlineSnapshotFixture,
  persistencePendingSnapshotFixture,
  recoverySnapshotFixture,
  runningSnapshotFixture
} from './helpers/batch-console-fixtures.mjs';

test('renders fixed controls, six counters, tab slots and full-lifecycle rows', () => {
  const document = consoleDocument();
  const view = createBatchConsoleView(document, consoleHandlers());

  view.render(runningSnapshotFixture());

  assert.equal(document.querySelector('[data-command-bar]').dataset.sticky, 'true');
  assert.equal(document.querySelectorAll('[data-summary-count]').length, 6);
  assert.equal(document.querySelectorAll('[data-worker-slot]').length, 3);
  assert.equal(document.querySelectorAll('[data-task-row]').length, 5);
  assert.equal(document.querySelectorAll('[data-task-card]').length, 5);
  assert.match(document.querySelector('[data-worker-slot]').textContent, /标签页 101/);
  assert.doesNotMatch(document.querySelector('[data-console-overview]').textContent, /窗口槽位/);
  assert.match(document.querySelector('[data-task-row="18"]').textContent, /处理超时/);
});

test('uses distinct pause and irreversible stop confirmations with semantic arguments', () => {
  const document = consoleDocument();
  const calls = [];
  const view = createBatchConsoleView(document, consoleHandlers({
    onPause() {
      calls.push(['pause']);
    },
    onStop(confirmedRisk) {
      calls.push(['stop', confirmedRisk]);
    }
  }));
  view.render(runningSnapshotFixture());

  click(document, '[data-action="pause"]');
  assert.match(document.querySelector('[role="dialog"]').textContent, /稍后可继续/);
  click(document, '[data-dialog-cancel]');
  click(document, '[data-action="stop"]');
  assert.match(document.querySelector('[role="dialog"]').textContent, /不能恢复/);
  assert.match(document.querySelector('[data-dialog-confirm]').className, /danger/);
  click(document, '[data-dialog-confirm]');

  assert.deepEqual(calls, [['stop', true]]);
});

test('dispatches safe retry directly and confirms uncertain retry before requeueing', () => {
  const document = consoleDocument();
  const calls = [];
  const view = createBatchConsoleView(document, consoleHandlers({
    onRetry(row, confirmedRisk) {
      calls.push([row.urlIndex, confirmedRisk]);
    }
  }));
  view.render(runningSnapshotFixture());

  click(document, '[data-action="retry"][data-url-index="18"]');
  assert.deepEqual(calls, [[18, false]]);
  assert.equal(document.querySelector('[role="dialog"]'), null);

  click(document, '[data-action="retry"][data-url-index="17"]');
  const dialog = document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /重复评论/);
  assert.match(dialog.textContent, /先人工检查/);
  click(document, '[data-dialog-confirm]');
  assert.deepEqual(calls, [[18, false], [17, true]]);
});

test('filters queue, opens details, focuses worker tabs and records manual outcomes', () => {
  const document = consoleDocument();
  const calls = [];
  const view = createBatchConsoleView(document, consoleHandlers({
    onFilterChange(filters) {
      calls.push(['filter', filters]);
    },
    onFocusTab(row) {
      calls.push(['focus-tab', row.urlIndex]);
    },
    onOpenManual(row) {
      calls.push(['manual-open', row.urlIndex]);
    },
    onManualUpdate(row, status) {
      calls.push(['manual-update', row.urlIndex, status]);
    }
  }));
  view.render(runningSnapshotFixture());

  change(document, '[name="queueStatus"]', 'manual');
  change(document, '[name="queueDomain"]', 'manual.test');
  const search = document.querySelector('[name="queueKeyword"]');
  search.value = '提交确认';
  search.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  click(document, '[data-action="details"][data-url-index="17"]');
  assert.match(document.querySelector('[data-task-drawer]').textContent, /submission_uncertain/);
  assert.match(document.querySelector('[data-task-drawer]').textContent, /Potentially submitted draft/);
  click(document, '[data-drawer-close]');
  click(document, '[data-action="focus-tab"][data-url-index="0"]');
  click(document, '[data-action="manual"][data-url-index="17"]');
  click(document, '[data-action="manual-resolved"][data-url-index="17"]');
  click(document, '[data-action="manual-unresolved"][data-url-index="17"]');

  assert.deepEqual(calls, [
    ['filter', {
      status: 'manual',
      domain: 'all',
      timeRange: 'all',
      keyword: ''
    }],
    ['filter', {
      status: 'manual',
      domain: 'manual.test',
      timeRange: 'all',
      keyword: ''
    }],
    ['filter', {
      status: 'manual',
      domain: 'manual.test',
      timeRange: 'all',
      keyword: '提交确认'
    }],
    ['focus-tab', 0],
    ['manual-open', 17],
    ['manual-update', 17, 'resolved'],
    ['manual-update', 17, 'unresolved']
  ]);
});

test('renders offline, recovery, persistence, error and empty states from snapshots', () => {
  const document = consoleDocument();
  const view = createBatchConsoleView(document, consoleHandlers());

  for (const [fixture, expected] of [
    [offlineSnapshotFixture, '恢复在线后仍需手动继续'],
    [recoverySnapshotFixture, '已从检查点安全恢复'],
    [persistencePendingSnapshotFixture, '继续处理已锁定'],
    [errorSnapshotFixture, 'worker_pause_failed']
  ]) {
    view.render(fixture());
    assert.match(document.querySelector('[data-console-banners]').textContent, new RegExp(expected));
  }

  view.render(emptySnapshotFixture());
  assert.match(document.querySelector('[data-console-empty]').textContent, /新建批次/);
  assert.equal(document.querySelector('[data-action="new-batch"]').disabled, false);
});

test('projects hostile labels and task data as text without creating attacker nodes', () => {
  const document = consoleDocument();
  let commandPayload = null;
  const snapshot = runningSnapshotFixture();
  snapshot.batchName = '<img src=x data-attacker-node>';
  snapshot.assignment.identityLabel = '<button data-attacker-node>steal</button>';
  snapshot.rows[0].url = 'https://safe.test/<svg data-attacker-node>';
  snapshot.rows[0].errorMessage = '<script data-attacker-node>bad()</script>';
  snapshot.rows[0].password = 'row-password-sentinel';
  snapshot.filteredRows = snapshot.rows;
  const view = createBatchConsoleView(document, consoleHandlers({
    onRetry(row) {
      commandPayload = row;
    }
  }));

  view.render(snapshot);
  click(document, '[data-action="retry"][data-url-index="18"]');

  assert.equal(document.querySelector('[data-attacker-node]'), null);
  assert.match(document.querySelector('[data-batch-name]').textContent, /<img/);
  assert.match(document.querySelector('[data-task-row="18"]').textContent, /<script/);
  assert.equal(document.body.textContent.includes('row-password-sentinel'), false);
  assert.equal(JSON.stringify(commandPayload).includes('row-password-sentinel'), false);
});
