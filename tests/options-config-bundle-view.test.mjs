import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createOptionsConfigBundleView } from '../lib/options-config-bundle-view.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function previewFixture(overrides = {}) {
  return Object.freeze({
    previewId: 'opaque-preview',
    creates: Object.freeze([1, 2, 3, 4, 5, 6]),
    updates: Object.freeze([1, 2, 3]),
    conflicts: Object.freeze([]),
    settingChanges: Object.freeze(['llm', 'batchDefaults', 'preferences']),
    ...overrides
  });
}

function createViewHarness(overrides = {}) {
  const dom = new JSDOM(`
    <button id="exportConfigBtn" type="button">export</button>
    <button id="importConfigBtn" type="button">import</button>
    <input id="importConfigFileInput" type="file">
    <button id="applyImportConfigBtn" type="button" hidden>apply</button>
    <span id="importExportStatus"></span>
    <div id="importPreviewSummary" hidden></div>
  `);
  const { document, Event } = dom.window;
  const calls = {
    export: 0,
    preview: [],
    apply: [],
    downloads: [],
    applied: []
  };
  const defaultPreview = previewFixture();
  const controller = {
    async exportConfig() {
      calls.export += 1;
      return { format: 'autocomment-config-bundle', version: 3 };
    },
    async previewImport(value) {
      calls.preview.push(value);
      return defaultPreview;
    },
    async applyImport(preview) {
      calls.apply.push(preview);
      return { applied: true };
    },
    ...overrides.controller
  };
  const view = createOptionsConfigBundleView({
    documentRef: document,
    controller,
    downloadJson(value, fileName) {
      calls.downloads.push({ value, fileName });
    },
    async onApplied(value) {
      calls.applied.push(value);
      return overrides.onApplied?.(value);
    }
  });
  const fileInput = document.getElementById('importConfigFileInput');

  function selectFile(file, fileName = file.name || 'config.json') {
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [file]
    });
    Object.defineProperty(fileInput, 'value', {
      configurable: true,
      writable: true,
      value: `C:\\fakepath\\${fileName}`
    });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function selectText(text, fileName = 'config.json') {
    selectFile({
      name: fileName,
      async text() {
        return text;
      }
    }, fileName);
  }

  return {
    calls,
    controller,
    document,
    view,
    fileInput,
    exportButton: document.getElementById('exportConfigBtn'),
    importButton: document.getElementById('importConfigBtn'),
    applyButton: document.getElementById('applyImportConfigBtn'),
    status: document.getElementById('importExportStatus'),
    summary: document.getElementById('importPreviewSummary'),
    selectFile,
    selectText
  };
}

test('previews one selected file and applies only after explicit click', async () => {
  const harness = createViewHarness();

  harness.selectText(JSON.stringify({ version: 3 }));
  await flush();

  assert.match(harness.summary.textContent, /新增 6/);
  assert.match(harness.summary.textContent, /更新 3/);
  assert.match(harness.summary.textContent, /设置变化 3/);
  assert.equal(harness.summary.hidden, false);
  assert.equal(harness.applyButton.hidden, false);
  assert.equal(harness.calls.apply.length, 0);

  harness.applyButton.click();
  await flush();

  assert.equal(harness.calls.apply.length, 1);
  assert.equal(harness.calls.applied.length, 1);
  assert.deepEqual(harness.calls.applied[0], { applied: true });
  assert.equal(harness.applyButton.hidden, true);
});

test('invalid JSON is rejected without previewing or applying', async () => {
  const harness = createViewHarness();

  harness.selectText('{invalid');
  await flush();

  assert.match(harness.status.textContent, /JSON/);
  assert.equal(harness.calls.preview.length, 0);
  assert.equal(harness.calls.apply.length, 0);
  assert.equal(harness.applyButton.hidden, true);
  assert.equal(harness.summary.hidden, true);
});

test('conflict codes are rendered as text and block apply', async () => {
  const harness = createViewHarness({
    controller: {
      async previewImport(value) {
        harness.calls.preview.push(value);
        return previewFixture({
          conflicts: Object.freeze([
            Object.freeze({ code: 'duplicate_profile_id' }),
            Object.freeze({ code: '<unsafe-conflict>' })
          ])
        });
      }
    }
  });

  harness.selectText('{}');
  await flush();

  assert.match(harness.summary.textContent, /duplicate_profile_id/);
  assert.match(harness.summary.textContent, /<unsafe-conflict>/);
  assert.equal(harness.summary.querySelector('script'), null);
  assert.equal(harness.applyButton.hidden, true);
});

test('resets the native input and repeated selections replace the pending preview', async () => {
  const firstPreview = previewFixture({ previewId: 'first' });
  const secondPreview = previewFixture({ previewId: 'second' });
  let previewNumber = 0;
  const harness = createViewHarness({
    controller: {
      async previewImport(value) {
        harness.calls.preview.push(value);
        previewNumber += 1;
        return previewNumber === 1 ? firstPreview : secondPreview;
      }
    }
  });

  harness.selectText('{"selected":1}');
  await flush();
  assert.equal(harness.fileInput.value, '');

  harness.selectText('{"selected":1}');
  await flush();
  assert.equal(harness.fileInput.value, '');
  assert.equal(harness.calls.preview.length, 2);

  harness.applyButton.click();
  await flush();
  assert.deepEqual(harness.calls.apply, [secondPreview]);
});

test('disables every action while a command is in flight and ignores re-entry', async () => {
  const pendingPreview = deferred();
  const harness = createViewHarness({
    controller: {
      async previewImport(value) {
        harness.calls.preview.push(value);
        return pendingPreview.promise;
      }
    }
  });

  harness.selectText('{}');
  assert.equal(harness.exportButton.disabled, true);
  assert.equal(harness.importButton.disabled, true);
  assert.equal(harness.applyButton.disabled, true);
  await flush();

  harness.exportButton.dispatchEvent(
    new harness.document.defaultView.Event('click', { bubbles: true })
  );
  harness.selectText('{"second":true}');
  assert.equal(harness.calls.export, 0);
  assert.equal(harness.calls.preview.length, 1);

  pendingPreview.resolve(previewFixture());
  await flush();
  assert.equal(harness.exportButton.disabled, false);
  assert.equal(harness.importButton.disabled, false);
  assert.equal(harness.applyButton.disabled, false);
});

test('exports with the injected downloader and reports command errors', async () => {
  const harness = createViewHarness();

  harness.exportButton.click();
  await flush();

  assert.equal(harness.calls.export, 1);
  assert.equal(harness.calls.downloads.length, 1);
  assert.equal(
    harness.calls.downloads[0].value.format,
    'autocomment-config-bundle'
  );
  assert.match(harness.calls.downloads[0].fileName, /\.json$/);
  assert.match(harness.status.textContent, /已导出/);
  assert.equal(harness.status.classList.contains('status-warning'), false);

  const failed = createViewHarness({
    controller: {
      async exportConfig() {
        throw new Error('export_unavailable');
      }
    }
  });
  failed.exportButton.click();
  await flush();
  assert.match(failed.status.textContent, /export_unavailable/);
  assert.equal(failed.status.classList.contains('status-warning'), true);
});

test('reports refresh failure distinctly after the import is already committed', async () => {
  const harness = createViewHarness({
    async onApplied() {
      throw new Error('refresh_failed');
    }
  });
  harness.selectText('{}');
  await flush();

  harness.applyButton.click();
  await flush();

  assert.equal(harness.calls.apply.length, 1);
  assert.equal(harness.calls.applied.length, 1);
  assert.match(harness.status.textContent, /已应用/);
  assert.match(harness.status.textContent, /页面刷新失败/);
  assert.doesNotMatch(harness.status.textContent, /^应用失败/);
  assert.equal(harness.applyButton.hidden, true);
});

test('destroy during a deferred file read never invokes preview', async () => {
  const fileRead = deferred();
  const harness = createViewHarness();
  harness.selectFile({
    name: 'deferred.json',
    text() {
      return fileRead.promise;
    }
  });
  assert.equal(harness.calls.preview.length, 0);

  harness.view.destroy();
  fileRead.resolve('{}');
  await flush();

  assert.equal(harness.calls.preview.length, 0);
});

test('destroy removes all registered action listeners', async () => {
  const harness = createViewHarness();
  let nativePickerClicks = 0;
  harness.fileInput.click = () => {
    nativePickerClicks += 1;
  };

  harness.view.destroy();
  harness.exportButton.click();
  harness.importButton.click();
  harness.selectText('{}');
  harness.applyButton.hidden = false;
  harness.applyButton.click();
  await flush();

  assert.equal(harness.calls.export, 0);
  assert.equal(nativePickerClicks, 0);
  assert.equal(harness.calls.preview.length, 0);
  assert.equal(harness.calls.apply.length, 0);
});
