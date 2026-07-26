import assert from 'node:assert/strict';
import test from 'node:test';

import { createBatchConsoleView } from '../lib/batch-console-view.mjs';
import {
  click,
  consoleDocument,
  consoleHandlers,
  recoverySnapshotFixture,
  runningSnapshotFixture
} from './helpers/batch-console-fixtures.mjs';

test('exposes labelled status regions and equivalent mobile task data', () => {
  const document = consoleDocument();
  const view = createBatchConsoleView(document, consoleHandlers());
  view.render(recoverySnapshotFixture());

  assert.ok(document.querySelector('[aria-live="polite"][data-batch-status]'));
  assert.ok(document.querySelector('table thead th[scope="col"]'));
  const row = document.querySelector('[data-task-row="17"]');
  const card = document.querySelector('[data-task-card="17"]');
  assert.match(row.getAttribute('aria-label'), /需人工/);
  assert.match(row.getAttribute('aria-label'), /提交确认前中断/);
  assert.equal(card.getAttribute('aria-label'), row.getAttribute('aria-label'));
  for (const value of ['17', 'manual.test', '22 秒', '提交确认前中断']) {
    assert.match(card.textContent, new RegExp(value));
  }
});

test('traps focus in details and confirmation layers then restores the trigger', () => {
  const document = consoleDocument();
  const view = createBatchConsoleView(document, consoleHandlers());
  view.render(runningSnapshotFixture());
  const detailsTrigger = document.querySelector(
    '[data-action="details"][data-url-index="17"]'
  );
  detailsTrigger.focus();

  click(document, '[data-action="details"][data-url-index="17"]');
  const drawer = document.querySelector('[data-task-drawer]');
  assert.equal(drawer.contains(document.activeElement), true);
  const drawerButtons = [...drawer.querySelectorAll('button:not([disabled])')];
  drawerButtons.at(-1).focus();
  drawerButtons.at(-1).dispatchEvent(new document.defaultView.KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true
  }));
  assert.equal(document.activeElement, drawerButtons[0]);
  document.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true
  }));
  assert.equal(document.querySelector('[data-task-drawer]'), null);
  assert.equal(document.activeElement, detailsTrigger);

  const stopTrigger = document.querySelector('[data-action="stop"]');
  stopTrigger.focus();
  click(document, '[data-action="stop"]');
  assert.equal(
    document.querySelector('[role="dialog"]').contains(document.activeElement),
    true
  );
  click(document, '[data-dialog-cancel]');
  assert.equal(document.activeElement, stopTrigger);
});

test('keeps an in-flight danger layer busy, disabled and immune to Escape', () => {
  const document = consoleDocument();
  const view = createBatchConsoleView(document, consoleHandlers());
  view.render(runningSnapshotFixture());
  click(document, '[data-action="stop"]');

  const pending = runningSnapshotFixture();
  pending.command.inFlight = 'stop';
  pending.command.canPause = false;
  pending.command.canStop = false;
  view.render(pending);
  document.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true
  }));

  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.equal(dialog.getAttribute('aria-busy'), 'true');
  assert.equal(dialog.querySelector('[data-dialog-confirm]').disabled, true);
  assert.equal(dialog.querySelector('[data-dialog-cancel]').disabled, true);
});

test('marks the command surface busy and disables task mutations in flight', () => {
  const document = consoleDocument();
  const view = createBatchConsoleView(document, consoleHandlers());
  const pending = runningSnapshotFixture();
  pending.command.inFlight = 'retry';

  view.render(pending);

  assert.equal(document.querySelector('[data-command-bar]').getAttribute('aria-busy'), 'true');
  for (const action of document.querySelectorAll(
    '[data-action="retry"],[data-action="manual"],'
      + '[data-action="manual-resolved"],[data-action="manual-unresolved"],'
      + '[data-action="focus-tab"]'
  )) {
    assert.equal(action.disabled, true);
  }
  assert.equal(
    document.querySelector('[data-action="details"]').disabled,
    false
  );
});

test('provides labels, scopes and text status without relying on color', () => {
  const document = consoleDocument();
  const view = createBatchConsoleView(document, consoleHandlers());
  view.render(runningSnapshotFixture());

  assert.equal(document.querySelector('[name="queueKeyword"]').labels.length, 1);
  assert.equal(document.querySelector('[name="queueStatus"]').labels.length, 1);
  assert.ok(document.querySelector('table caption'));
  assert.equal(document.querySelectorAll('tbody th[scope="row"]').length, 5);
  assert.match(document.querySelector('[data-batch-status]').textContent, /运行中/);
  assert.ok(document.querySelector('[role="status"][data-command-result]'));
});
