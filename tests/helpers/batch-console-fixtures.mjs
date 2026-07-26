import { JSDOM } from 'jsdom';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function consoleDocument() {
  return new JSDOM(`<!doctype html>
    <html lang="zh-CN">
      <body>
        <button type="button" data-outside-trigger>控制台外部触发器</button>
        <header data-app-shell></header>
        <main data-batch-console></main>
      </body>
    </html>`, {
    url: 'http://127.0.0.1:4173/tests/fixtures/batch-console-page.html',
    pretendToBeVisual: true
  }).window.document;
}

export function consoleHandlers(overrides = {}) {
  return {
    onPause() {},
    onResume() {},
    onStop() {},
    onRetry() {},
    onOpenManual() {},
    onManualUpdate() {},
    onFocusTab() {},
    onFilterChange() {},
    onNewBatch() {},
    onExport() {},
    ...overrides
  };
}

function taskRows() {
  return [{
    taskId: 'batch-1:18:1',
    urlIndex: 18,
    attempt: 1,
    url: 'https://old.blog/article',
    domain: 'old.blog',
    state: 'terminal',
    status: 'failed',
    phase: null,
    elapsedMs: 61000,
    result: 'fail',
    error: {
      code: 'task_timeout',
      message: '处理超时，worker 标签页已安全关闭',
      retryPolicy: 'safe',
      diagnostic: { phase: 'generating', elapsedMs: 61000 }
    },
    errorMessage: '处理超时，worker 标签页已安全关闭',
    retryPolicy: 'safe',
    actions: ['details', 'retry', 'manual'],
    manualResolution: { status: 'idle', updatedAt: null },
    attemptHistory: [],
    aiContent: 'A safe generated draft.',
    timestamp: 70000
  }, {
    taskId: 'batch-1:17:1',
    urlIndex: 17,
    attempt: 1,
    url: 'https://manual.test/page',
    domain: 'manual.test',
    state: 'terminal',
    status: 'manual',
    phase: null,
    elapsedMs: 22000,
    result: 'manual_required',
    error: {
      code: 'submission_uncertain',
      message: '提交确认前中断，评论可能已提交',
      retryPolicy: 'confirm',
      diagnostic: { phase: 'submitting', elapsedMs: 22000 }
    },
    errorMessage: '提交确认前中断，评论可能已提交',
    retryPolicy: 'confirm',
    actions: ['details', 'retry', 'manual'],
    manualResolution: { status: 'idle', updatedAt: null },
    attemptHistory: [{
      attempt: 0,
      result: 'fail',
      error: {
        code: 'content_script_unavailable',
        message: '目标页面未能启动扩展内容脚本'
      },
      timestamp: 40000,
      elapsedMs: 3000
    }],
    aiContent: 'Potentially submitted draft.',
    timestamp: 69000
  }, ...Array.from({ length: 3 }, (_, offset) => ({
    taskId: `batch-1:${offset}:1`,
    urlIndex: offset,
    attempt: 1,
    url: `https://target.test/${offset}`,
    domain: 'target.test',
    state: 'active',
    status: 'running',
    phase: ['loading', 'detecting', 'generating'][offset],
    elapsedMs: (offset + 1) * 1000,
    result: null,
    error: null,
    errorMessage: null,
    retryPolicy: 'safe',
    actions: ['details', 'focus-tab'],
    manualResolution: { status: 'idle', updatedAt: null },
    attemptHistory: [],
    aiContent: null,
    timestamp: 68000 - offset
  }))];
}

export function runningSnapshotFixture() {
  const rows = taskRows();
  return clone({
    batchId: 'batch-1',
    status: 'running',
    batchName: '夏季外链批次',
    online: true,
    lastCheckpointSavedAt: 69800,
    checkpointState: 'saved',
    keepAlive: true,
    counts: {
      total: 5,
      queued: 0,
      running: 3,
      success: 0,
      failed: 1,
      manual: 1
    },
    assignment: {
      identityLabel: '默认身份 · CloudHu',
      promotionSiteLabel: 'promo.test',
      automationLabel: '生成并自动提交',
      limitsLabel: '并发 3 · 超时 60s'
    },
    slots: rows.slice(2).map((row, index) => ({
      taskId: row.taskId,
      urlIndex: row.urlIndex,
      attempt: row.attempt,
      url: row.url,
      domain: row.domain,
      phase: row.phase,
      elapsedMs: row.elapsedMs,
      tabId: 101 + index,
      tabLabel: `标签页 ${101 + index}`
    })),
    rows,
    filteredRows: rows,
    filters: {
      status: 'all',
      domain: 'all',
      timeRange: 'all',
      keyword: ''
    },
    banners: [],
    command: {
      inFlight: null,
      canPause: true,
      canResume: false,
      canStop: true,
      canExport: true,
      canCreate: false
    }
  });
}

export function recoverySnapshotFixture() {
  const snapshot = runningSnapshotFixture();
  return {
    ...snapshot,
    status: 'paused_recovery',
    slots: [],
    banners: [{
      kind: 'recovery',
      title: '已从检查点安全恢复',
      message: '1 个提交中断任务已标记需人工'
    }],
    command: {
      ...snapshot.command,
      canPause: false,
      canResume: true,
      canCreate: true
    }
  };
}

export function offlineSnapshotFixture() {
  const snapshot = recoverySnapshotFixture();
  return {
    ...snapshot,
    online: false,
    banners: [{
      kind: 'offline',
      title: '当前离线',
      message: '批次已安全暂停；恢复在线后仍需手动继续。'
    }]
  };
}

export function persistencePendingSnapshotFixture() {
  const snapshot = recoverySnapshotFixture();
  return {
    ...snapshot,
    persistencePending: true,
    checkpointState: 'pending',
    banners: [{
      kind: 'persistence',
      title: '恢复检查点尚未持久化',
      message: '继续处理已锁定，请先保留当前页面并重试保存。'
    }],
    command: {
      ...snapshot.command,
      canResume: false
    }
  };
}

export function errorSnapshotFixture() {
  const snapshot = recoverySnapshotFixture();
  return {
    ...snapshot,
    banners: [{
      kind: 'error',
      title: '运行时发生错误',
      message: 'worker_pause_failed'
    }]
  };
}

export function emptySnapshotFixture() {
  return {
    batchId: '',
    status: 'empty',
    batchName: '',
    online: true,
    counts: {
      total: 0,
      queued: 0,
      running: 0,
      success: 0,
      failed: 0,
      manual: 0
    },
    assignment: {},
    slots: [],
    rows: [],
    filteredRows: [],
    filters: {
      status: 'all',
      domain: 'all',
      timeRange: 'all',
      keyword: ''
    },
    banners: [],
    command: {
      inFlight: null,
      canPause: false,
      canResume: false,
      canStop: false,
      canExport: false,
      canCreate: true
    }
  };
}

export function producerCheckpointFixture(status = 'paused_recovery') {
  const parsedUrls = Array.from({ length: 3 }, (_, originalIndex) => ({
    originalIndex,
    url: `https://producer.test/${originalIndex}`,
    sourceDomain: 'producer.test',
    originalRow: [`https://producer.test/${originalIndex}`]
  }));
  return {
    version: 2,
    batchId: 'producer-batch-1',
    status,
    createdAt: 1000,
    updatedAt: 69000,
    source: {
      fileName: 'producer-targets.csv',
      headers: ['原URL'],
      rows: parsedUrls.map((item) => item.originalRow),
      parsedUrls
    },
    settings: {
      autoOpenPanel: false,
      autoGenerate: true,
      autoSubmit: true,
      concurrency: 3,
      timeoutSeconds: 60,
      assignment: {
        identityId: 'default-identity',
        promotionSiteId: 'default-promotion-site',
        identitySnapshot: {
          displayName: 'Producer User',
          email: 'producer@example.test'
        },
        promotionSiteSnapshot: {
          label: 'producer-promo.test',
          url: 'https://producer-promo.test/',
          contentSummary: 'Producer integration fixture'
        }
      }
    },
    cursor: { nextIndex: 0 },
    tasks: Object.fromEntries(parsedUrls.map((item) => [
      String(item.originalIndex),
      {
        urlIndex: item.originalIndex,
        attempt: 1,
        state: 'queued',
        phase: null,
        tabId: null,
        windowId: null,
        startedAt: null,
        updatedAt: 69000,
        manualResolution: {
          status: 'idle',
          updatedAt: null
        }
      }
    ])),
    results: []
  };
}

export function click(document, selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`missing fixture selector: ${selector}`);
  element.dispatchEvent(new document.defaultView.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0
  }));
  return element;
}

export function change(document, selector, value) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`missing fixture selector: ${selector}`);
  element.value = value;
  element.dispatchEvent(new document.defaultView.Event('change', {
    bubbles: true,
    cancelable: true
  }));
  return element;
}
