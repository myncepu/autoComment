import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import {
  exportBatchResultsCsv
} from '../lib/batch-page-composition.mjs';

function createExportHarness() {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'chrome-extension://extension-id/batch.html'
  });
  const blobs = [];
  const downloads = [];
  Object.defineProperty(dom.window, 'Blob', {
    configurable: true,
    value: Blob
  });
  Object.defineProperty(dom.window.URL, 'createObjectURL', {
    configurable: true,
    value(blob) {
      blobs.push(blob);
      return 'blob:batch-export';
    }
  });
  Object.defineProperty(dom.window.URL, 'revokeObjectURL', {
    configurable: true,
    value(url) {
      assert.equal(url, 'blob:batch-export');
    }
  });
  dom.window.HTMLAnchorElement.prototype.click = function click() {
    downloads.push({ href: this.href, download: this.download });
  };
  return { blobs, document: dom.window.document, downloads };
}

test('legacy export uses generic source headers and appends the result column', async () => {
  const harness = createExportHarness();

  assert.equal(exportBatchResultsCsv(harness.document, null, {
    batchId: 'legacy-batch',
    results: [{
      originalIndex: 0,
      originalRow: ['https://target.test/', 'target.test'],
      result: 'success'
    }]
  }), true);

  assert.deepEqual(harness.downloads, [{
    href: 'blob:batch-export',
    download: 'batch_result_legacy-batch.csv'
  }]);
  assert.deepEqual(
    [...new Uint8Array(await harness.blobs[0].arrayBuffer()).slice(0, 3)],
    [0xef, 0xbb, 0xbf]
  );
  assert.equal(
    await harness.blobs[0].text(),
    '列1,列2,运行结果\nhttps://target.test/,target.test,√'
  );
});

test('checkpoint export redacts sensitive original-row columns', async () => {
  const harness = createExportHarness();
  const checkpoint = {
    batchId: 'batch-1',
    source: {
      headers: ['URL', 'Password', 'API Token']
    },
    results: [{
      originalIndex: 0,
      originalRow: [
        'https://target.test/',
        'password-must-not-export',
        'token-must-not-export'
      ],
      result: 'manual_required'
    }]
  };

  assert.equal(
    exportBatchResultsCsv(harness.document, checkpoint, null),
    true
  );

  const csv = await harness.blobs[0].text();
  assert.equal(
    csv,
    'URL,Password,API Token,运行结果\n'
      + 'https://target.test/,[REDACTED],[REDACTED],需手动处理'
  );
  assert.equal(csv.includes('password-must-not-export'), false);
  assert.equal(csv.includes('token-must-not-export'), false);
});

test('batch export neutralizes spreadsheet formulas in headers and cells', async () => {
  const harness = createExportHarness();
  const checkpoint = {
    batchId: 'formula-batch',
    source: {
      headers: ['=Injected Header', '+Second', 'Safe']
    },
    results: [{
      originalIndex: 0,
      originalRow: ['\t=SUM(A1:A2)', '\r@cmd', '-1'],
      result: 'success'
    }]
  };

  assert.equal(
    exportBatchResultsCsv(harness.document, checkpoint, null),
    true
  );

  assert.equal(
    await harness.blobs[0].text(),
    "'=Injected Header,'+Second,Safe,运行结果\n"
      + `'\t=SUM(A1:A2),"'\r@cmd",'-1,√`
  );
});
