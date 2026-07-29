import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import {
  exportBatchDiagnosticsJson,
  exportBatchResultsCsv,
  hasWorkerCapacityGap,
  hasWorkerCompletionGap
} from '../lib/batch-page-composition.mjs';

test('detects queued work when durable active slots fall below concurrency', () => {
  const checkpoint = {
    status: 'running',
    settings: { concurrency: 10 },
    tasks: Object.fromEntries([
      ...Array.from({ length: 3 }, (_, index) => [
        String(index),
        { state: 'active' }
      ]),
      ...Array.from({ length: 7 }, (_, offset) => [
        String(offset + 3),
        { state: 'terminal' }
      ]),
      ...Array.from({ length: 28 }, (_, offset) => [
        String(offset + 10),
        { state: 'queued' }
      ])
    ])
  };

  assert.equal(hasWorkerCapacityGap(checkpoint), true);
  checkpoint.tasks['10'].state = 'active';
  checkpoint.tasks['11'].state = 'active';
  checkpoint.tasks['12'].state = 'active';
  checkpoint.tasks['13'].state = 'active';
  checkpoint.tasks['14'].state = 'active';
  checkpoint.tasks['15'].state = 'active';
  checkpoint.tasks['16'].state = 'active';
  assert.equal(hasWorkerCapacityGap(checkpoint), false);
  checkpoint.status = 'paused';
  checkpoint.tasks['10'].state = 'queued';
  assert.equal(hasWorkerCapacityGap(checkpoint), false);
});

test('detects a running checkpoint whose tasks are all terminal', () => {
  const checkpoint = {
    status: 'running',
    tasks: {
      0: { state: 'terminal' },
      1: { state: 'terminal' }
    }
  };

  assert.equal(hasWorkerCompletionGap(checkpoint), true);
  checkpoint.tasks['1'].state = 'active';
  assert.equal(hasWorkerCompletionGap(checkpoint), false);
  checkpoint.tasks['1'].state = 'terminal';
  checkpoint.status = 'completed';
  assert.equal(hasWorkerCompletionGap(checkpoint), false);
  checkpoint.status = 'running';
  checkpoint.tasks = {};
  assert.equal(hasWorkerCompletionGap(checkpoint), false);
});

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
      result: 'success',
      submittedAt: Date.UTC(2026, 6, 28, 4, 5, 6)
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
    '列1,列2,运行结果,评论时间\n'
      + 'https://target.test/,target.test,发布成功,2026-07-28T04:05:06.000Z'
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
    'URL,Password,API Token,运行结果,评论时间\n'
      + 'https://target.test/,[REDACTED],[REDACTED],需手动处理,'
  );
  assert.equal(csv.includes('password-must-not-export'), false);
  assert.equal(csv.includes('token-must-not-export'), false);
});

test('v3 export attributes every result to frozen Profile and Promotion Site labels', async () => {
  const harness = createExportHarness();
  const checkpoint = {
    version: 3,
    batchId: 'batch-v3',
    profiles: {
      'profile-a': {
        id: 'profile-a',
        displayName: '作者 A',
        name: 'Private Name',
        email: 'private@example.test'
      }
    },
    promotionSites: {
      'site-a': {
        id: 'site-a',
        name: '产品 A',
        url: 'https://promo.test/',
        content: 'Private configuration content'
      }
    },
    source: { headers: ['URL'] },
    results: [{
      originalIndex: 0,
      originalRow: ['https://target.test/'],
      profileId: 'profile-a',
      promotionSiteId: 'site-a',
      result: 'success',
      submittedAt: Date.UTC(2026, 6, 28, 4, 5, 6)
    }]
  };

  exportBatchResultsCsv(harness.document, checkpoint, null);
  const csv = await harness.blobs[0].text();
  assert.equal(
    csv,
    'URL,Profile ID,执行身份名称,Promotion Site ID,执行推广网站名称,运行结果,评论时间\n'
      + 'https://target.test/,profile-a,作者 A,site-a,产品 A,发布成功,'
      + '2026-07-28T04:05:06.000Z'
  );
  assert.doesNotMatch(csv, /Private|private@/);
});

test('v3 export keeps assignment columns importable without duplicate aliases', async () => {
  const harness = createExportHarness();
  const checkpoint = {
    version: 3,
    batchId: 'batch-importable',
    profiles: {
      'profile-a': { displayName: '作者 A' }
    },
    promotionSites: {
      'site-a': { name: '产品 A' }
    },
    source: {
      headers: ['原URL', '来源域名', 'profileId', 'promotionSiteId']
    },
    results: [{
      originalIndex: 0,
      originalRow: [
        'https://target.test/',
        'target.test',
        'profile-a',
        'site-a'
      ],
      profileId: 'profile-a',
      promotionSiteId: 'site-a',
      result: 'success'
    }]
  };

  exportBatchResultsCsv(harness.document, checkpoint, null);

  assert.equal(
    await harness.blobs[0].text(),
    '原URL,来源域名,profileId,promotionSiteId,执行身份名称,执行推广网站名称,运行结果,评论时间\n'
      + 'https://target.test/,target.test,profile-a,site-a,作者 A,产品 A,发布成功,'
  );
});

test('checkpoint export emits only the latest attempt for each target row', async () => {
  const harness = createExportHarness();
  const checkpoint = {
    version: 3,
    batchId: 'batch-retried',
    source: { headers: ['URL'] },
    profiles: {},
    promotionSites: {},
    results: [{
      originalIndex: 0,
      attempt: 1,
      timestamp: 100,
      originalRow: ['https://retried.test/'],
      result: 'manual_required'
    }, {
      originalIndex: 0,
      attempt: 2,
      timestamp: 200,
      originalRow: ['https://retried.test/'],
      result: 'success',
      submittedAt: Date.UTC(2026, 6, 28, 4, 5, 6)
    }]
  };

  exportBatchResultsCsv(harness.document, checkpoint, null);

  const csv = await harness.blobs[0].text();
  assert.equal(csv.split('\n').length, 2);
  assert.match(csv, /发布成功,2026-07-28T04:05:06.000Z$/);
  assert.doesNotMatch(csv, /需手动处理/);
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
    "'=Injected Header,'+Second,Safe,运行结果,评论时间\n"
      + `'\t=SUM(A1:A2),"'\r@cmd",'-1,发布成功,`
  );
});

test('checkpoint export distinguishes historical success from unexecuted skips', async () => {
  const harness = createExportHarness();
  const checkpoint = {
    batchId: 'skip-reasons',
    source: { headers: ['URL'] },
    results: [{
      originalRow: ['https://published.test/'],
      result: 'skipped',
      skipReason: 'recent_success'
    }, {
      originalRow: ['https://duplicate.test/'],
      result: 'skipped',
      skipReason: 'duplicate_in_batch'
    }]
  };

  exportBatchResultsCsv(harness.document, checkpoint, null);

  assert.equal(
    await harness.blobs[0].text(),
    'URL,运行结果,评论时间\n'
      + 'https://published.test/,历史已成功发布,\n'
      + 'https://duplicate.test/,已跳过：批次内目标重复，未执行,'
  );
});

test('diagnostic export downloads readable JSON without task content', async () => {
  const harness = createExportHarness();
  const diagnostics = {
    schemaVersion: 1,
    batch: { batchId: 'batch:diagnostic/1' },
    privacy: {
      commentsIncluded: false,
      credentialsIncluded: false,
      fullUrlsIncluded: false
    },
    summary: {
      funnel: {
        generated: 10,
        filled: 9,
        submitDispatched: 7,
        serverConfirmed: 4
      }
    },
    events: [{
      event: 'submission_dispatch_result',
      host: 'blog.test',
      details: { dispatchResult: 'timeout' }
    }]
  };

  assert.equal(
    exportBatchDiagnosticsJson(harness.document, diagnostics),
    true
  );
  assert.deepEqual(harness.downloads, [{
    href: 'blob:batch-export',
    download: 'batch_diagnostics_batch_diagnostic_1.json'
  }]);
  assert.deepEqual(
    JSON.parse(await harness.blobs[0].text()),
    diagnostics
  );
});
