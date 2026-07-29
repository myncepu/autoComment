import {
  parseBatchCsv,
  preflightBatchRows
} from '../../lib/batch-preflight.mjs';
import { filterBatchTaskRows } from '../../lib/batch-console-state.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseFixtureCsv(text) {
  const data = [];
  const errors = [];
  let row = [];
  let value = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === ',' && !quoted) {
      row.push(value);
      value = '';
      continue;
    }
    if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim())) data.push(row);
      row = [];
      value = '';
      continue;
    }
    value += character;
  }

  if (quoted) {
    errors.push({
      code: 'MissingQuotes',
      message: 'Unclosed quoted field'
    });
  }
  row.push(value);
  if (row.some((cell) => cell.trim())) data.push(row);
  return { data, errors };
}

function initialDraft() {
  return {
    step: 1,
    assignment: {
      identityId: 'default-identity',
      promotionSiteId: 'default-promotion-site',
      identitySnapshot: {
        displayName: 'Fixture User',
        email: 'fixture@example.test'
      },
      promotionSiteSnapshot: {
        label: 'fixture-promo.test',
        url: 'https://fixture-promo.test/',
        contentSummary: '普通 HTTP 标签页中的本地确定性配置'
      }
    },
    preflight: null,
    settings: {
      autoOpenPanel: false,
      autoGenerate: true,
      autoSubmit: false,
      concurrency: 3,
      timeoutSeconds: 60
    },
    readinessError: '',
    parseError: ''
  };
}

function evaluateFixtureUrl(url) {
  const hostname = new URL(url).hostname;
  if (hostname === 'blocked.test' || hostname.endsWith('.blocked.test')) {
    return {
      blocked: true,
      code: 'illegal_site',
      reason: '命中 fixture 非法站点规则'
    };
  }
  return { blocked: false };
}

function initialRows() {
  const running = Array.from({ length: 3 }, (_, urlIndex) => ({
    taskId: `fixture-batch-001:${urlIndex}:1`,
    urlIndex,
    attempt: 1,
    url: `https://target.test/${urlIndex}`,
    domain: 'target.test',
    state: 'active',
    status: 'running',
    phase: ['loading', 'detecting', 'generating'][urlIndex],
    elapsedMs: (urlIndex + 1) * 1000,
    result: null,
    error: null,
    errorMessage: null,
    retryPolicy: 'safe',
    actions: ['details', 'focus-tab'],
    manualResolution: { status: 'idle', updatedAt: null },
    attemptHistory: [],
    aiContent: null,
    commentText: null,
    anchorTexts: [],
    promotedWebsiteUrl: 'https://fixture-promo.test/',
    timestamp: 70000 - urlIndex
  }));
  return [{
    taskId: 'fixture-batch-001:18:1',
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
    aiContent: 'Fixture safe retry draft.',
    commentText: 'Fixture safe retry draft.',
    anchorTexts: ['Old Blog Guide', 'Promotion Home'],
    promotedWebsiteUrl: 'https://fixture-promo.test/old-blog',
    timestamp: 71000
  }, {
    taskId: 'fixture-batch-001:17:1',
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
    attemptHistory: [],
    aiContent: 'Fixture uncertain draft.',
    commentText: 'Fixture uncertain draft.',
    anchorTexts: ['Manual Review'],
    promotedWebsiteUrl: 'https://fixture-promo.test/manual-review',
    timestamp: 70500
  }, ...running];
}

function calculateCounts(rows) {
  const counts = {
    total: rows.length,
    queued: 0,
    running: 0,
    success: 0,
    skipped: 0,
    failed: 0,
    manual: 0
  };
  for (const row of rows) {
    if (Object.hasOwn(counts, row.status)) counts[row.status] += 1;
  }
  return counts;
}

function workerSlots(rows) {
  return rows
    .filter((row) => row.status === 'running')
    .slice(0, 3)
    .map((row, index) => ({
      taskId: row.taskId,
      urlIndex: row.urlIndex,
      attempt: row.attempt,
      url: row.url,
      domain: row.domain,
      phase: row.phase,
      elapsedMs: row.elapsedMs,
      tabId: 501 + index,
      tabLabel: `标签页 ${501 + index}`
    }));
}

function runningSnapshot() {
  const rows = initialRows();
  return {
    batchId: 'fixture-batch-001',
    status: 'running',
    batchName: '普通 HTTP Fixture 批次',
    online: true,
    lastCheckpointSavedAt: 71000,
    checkpointState: 'saved',
    keepAlive: true,
    slotCapacity: 3,
    counts: calculateCounts(rows),
    assignment: {
      identityLabel: '默认身份 · Fixture User',
      promotionSiteLabel: 'fixture-promo.test',
      automationLabel: '生成但不自动提交',
      limitsLabel: '并发 3 · 超时 60s'
    },
    slots: workerSlots(rows),
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
      canCreate: true,
      resultMessage: ''
    }
  };
}

function pausedSnapshot(kind) {
  const snapshot = runningSnapshot();
  snapshot.status = 'paused_recovery';
  snapshot.keepAlive = false;
  snapshot.slots = [];
  snapshot.command = {
    ...snapshot.command,
    canPause: false,
    canResume: true,
    canCreate: true
  };
  const banner = {
    recovery: {
      kind: 'recovery',
      title: '已从检查点安全恢复',
      message: '任务不会自动继续；请检查后手动恢复。'
    },
    offline: {
      kind: 'offline',
      title: '当前离线',
      message: '批次已安全暂停；恢复在线后仍需手动继续。'
    },
    persistence: {
      kind: 'persistence',
      title: '恢复检查点尚未持久化',
      message: '继续处理已锁定，请保留当前页面。'
    },
    error: {
      kind: 'error',
      title: '运行时发生错误',
      message: 'worker_pause_failed'
    }
  }[kind];
  snapshot.banners = banner ? [banner] : [];
  if (kind === 'offline') snapshot.online = false;
  if (kind === 'persistence') {
    snapshot.persistencePending = true;
    snapshot.checkpointState = 'pending';
    snapshot.command.canResume = false;
  }
  return snapshot;
}

function emptySnapshot() {
  return {
    batchId: '',
    status: 'empty',
    batchName: '',
    online: true,
    slotCapacity: 0,
    counts: calculateCounts([]),
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
      canCreate: true,
      resultMessage: ''
    }
  };
}

function scenarioSnapshot(name) {
  if (name === 'offline') return pausedSnapshot('offline');
  if (name === 'recovery') return pausedSnapshot('recovery');
  if (name === 'persistence') return pausedSnapshot('persistence');
  if (name === 'error') return pausedSnapshot('error');
  if (name === 'empty') return emptySnapshot();
  return runningSnapshot();
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function commandAvailability(snapshot) {
  if (!snapshot.batchId || snapshot.status === 'empty') {
    return {
      canPause: false,
      canResume: false,
      canStop: false,
      canExport: false,
      canCreate: true
    };
  }
  if (snapshot.status === 'running') {
    return {
      canPause: true,
      canResume: false,
      canStop: true,
      canExport: true,
      canCreate: true
    };
  }
  if (snapshot.status === 'paused_recovery') {
    return {
      canPause: false,
      canResume: snapshot.persistencePending !== true && snapshot.online !== false,
      canStop: true,
      canExport: true,
      canCreate: true
    };
  }
  return {
    canPause: false,
    canResume: false,
    canStop: false,
    canExport: true,
    canCreate: true
  };
}

export function createBatchConsoleFixtureAdapter() {
  let savedDraft = initialDraft();
  let snapshot = runningSnapshot();
  let filters = clone(snapshot.filters);
  const listeners = new Set();
  const commandLog = [];

  function publish() {
    const publicSnapshot = clone(snapshot);
    for (const listener of [...listeners]) listener(publicSnapshot);
  }

  function updateSnapshot(nextSnapshot) {
    snapshot = clone(nextSnapshot);
    filters = clone(snapshot.filters || filters);
    const availability = commandAvailability(snapshot);
    snapshot.command = {
      ...(snapshot.command || {}),
      ...availability,
      inFlight: snapshot.command?.inFlight || null,
      resultMessage: snapshot.command?.resultMessage || ''
    };
    publish();
  }

  function findRow(task) {
    const row = snapshot.rows.find((candidate) => (
      candidate.urlIndex === task?.urlIndex &&
      candidate.attempt === task?.attempt
    ));
    if (!row) throw codedError('fixture_task_not_found');
    return row;
  }

  function refreshDerivedRows() {
    snapshot.counts = calculateCounts(snapshot.rows);
    snapshot.filters = clone(filters);
    snapshot.filteredRows = filterBatchTaskRows(snapshot.rows, filters);
  }

  async function runCommand(command, details, operation) {
    commandLog.push({
      command,
      at: commandLog.length + 1,
      ...clone(details || {})
    });
    snapshot.command.inFlight = command;
    snapshot.command.resultMessage = '';
    publish();
    await Promise.resolve();
    try {
      const outcome = await operation();
      snapshot.command.inFlight = null;
      snapshot.command.resultMessage = outcome?.message || '';
      Object.assign(snapshot.command, commandAvailability(snapshot));
      refreshDerivedRows();
      publish();
      return outcome?.value;
    } catch (error) {
      snapshot.command.inFlight = null;
      snapshot.command.resultMessage = `命令失败：${error?.code || error?.message || 'fixture_error'}`;
      Object.assign(snapshot.command, commandAvailability(snapshot));
      refreshDerivedRows();
      publish();
      throw error;
    }
  }

  const application = {
    loadDraft() {
      return clone(savedDraft);
    },
    saveDraft(draft) {
      savedDraft = clone(draft);
      return clone(savedDraft);
    },
    async parseFile(file) {
      if (!file || typeof file.text !== 'function') {
        throw new Error('csv_file_unreadable');
      }
      const parsed = parseBatchCsv(await file.text(), parseFixtureCsv);
      return {
        preflight: preflightBatchRows(parsed, {
          evaluateUrl: evaluateFixtureUrl
        }),
        parseError: ''
      };
    },
    getReadinessError(draft) {
      const included = draft?.preflight?.rows?.filter((row) => (
        row.included === true
        && ['eligible', 'duplicate'].includes(row.status)
      )).length || 0;
      return included > 0 ? '' : '请先导入至少一条可处理 URL';
    },
    getSnapshot() {
      return clone(snapshot);
    },
    injectSnapshot(nextSnapshot) {
      updateSnapshot(nextSnapshot);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setFilters(nextFilters) {
      filters = {
        status: nextFilters?.status || 'all',
        domain: nextFilters?.domain || 'all',
        timeRange: nextFilters?.timeRange || 'all',
        keyword: String(nextFilters?.keyword || '')
      };
      refreshDerivedRows();
      publish();
    },
    selectScenario(name) {
      updateSnapshot(scenarioSnapshot(name));
    },
    getCommandLog() {
      return clone(commandLog);
    }
  };

  const controller = {
    async start(draft) {
      const includedRows = draft?.preflight?.rows?.filter((row) => (
        row.included === true
        && ['eligible', 'duplicate'].includes(row.status)
      )) || [];
      if (includedRows.length === 0) throw codedError('fixture_batch_empty');
      return runCommand('start', {}, async () => {
        const completedRows = includedRows.map((row, index) => ({
          taskId: `fixture-batch-001:${index}:1`,
          urlIndex: index,
          attempt: 1,
          url: row.url,
          domain: row.sourceDomain || new URL(row.url).hostname,
          state: 'terminal',
          status: 'success',
          phase: null,
          elapsedMs: 1000 + index,
          result: 'success',
          error: null,
          errorMessage: null,
          retryPolicy: 'blocked',
          actions: ['details'],
          manualResolution: { status: 'idle', updatedAt: null },
          attemptHistory: [],
          aiContent: `Fixture result ${index + 1}`,
          commentText: `Fixture result ${index + 1}`,
          anchorTexts: [`Fixture anchor ${index + 1}`],
          promotedWebsiteUrl: 'https://fixture-promo.test/',
          timestamp: 72000 + index
        }));
        snapshot = {
          ...runningSnapshot(),
          status: 'completed',
          keepAlive: false,
          slots: [],
          rows: completedRows,
          filteredRows: completedRows,
          counts: calculateCounts(completedRows),
          command: {
            ...snapshot.command,
            inFlight: 'start'
          }
        };
        return {
          message: `新批次已完成：${includedRows.length} 条`,
          value: {
            command: 'start',
            batchId: 'fixture-batch-001',
            status: 'completed',
            counts: {
              total: includedRows.length,
              success: includedRows.length,
              failed: 0
            }
          }
        };
      });
    },
    pause() {
      return runCommand('pause', {}, async () => {
        snapshot.status = 'paused_recovery';
        snapshot.keepAlive = false;
        snapshot.slots = [];
        snapshot.banners = [{
          kind: 'recovery',
          title: '已安全暂停',
          message: '活动 worker 标签页已封存，稍后可继续。'
        }];
        return { message: '批次已安全暂停' };
      });
    },
    resume() {
      return runCommand('resume', {}, async () => {
        if (snapshot.persistencePending) {
          throw codedError('recovery_persistence_required');
        }
        snapshot.status = 'running';
        snapshot.online = true;
        snapshot.keepAlive = true;
        snapshot.banners = [];
        snapshot.slots = workerSlots(snapshot.rows);
        return { message: '批次已恢复，未自动恢复前的人工任务保持不变' };
      });
    },
    stop(confirmedRisk = false) {
      return runCommand('stop', { confirmedRisk }, async () => {
        if (confirmedRisk !== true) {
          throw codedError('stop_confirmation_required');
        }
        snapshot.status = 'terminated';
        snapshot.keepAlive = false;
        snapshot.slots = [];
        snapshot.banners = [{
          kind: 'notice',
          title: '批次已永久停止',
          message: '已有结果仍可导出；原批次不能恢复。'
        }];
        return { message: '批次已停止并保留结果' };
      });
    },
    retry(task, confirmedRisk = false) {
      return runCommand('retry', { confirmedRisk, task }, async () => {
        const row = findRow(task);
        if (row.retryPolicy === 'blocked') {
          throw codedError('retry_blocked');
        }
        if (row.retryPolicy === 'confirm' && confirmedRisk !== true) {
          throw codedError('retry_confirmation_required');
        }
        row.attempt += 1;
        row.taskId = `${snapshot.batchId}:${row.urlIndex}:${row.attempt}`;
        row.state = 'queued';
        row.status = 'queued';
        row.phase = null;
        row.elapsedMs = null;
        row.result = null;
        row.error = null;
        row.errorMessage = null;
        row.retryPolicy = 'safe';
        row.actions = ['details'];
        row.manualResolution = { status: 'idle', updatedAt: null };
        return {
          message: confirmedRisk
            ? '已确认风险并重新排队'
            : '安全失败已重新排队'
        };
      });
    },
    openManual(task) {
      return runCommand('manual-open', { task }, async () => {
        const row = findRow(task);
        row.manualResolution = {
          status: 'in_progress',
          updatedAt: 73000 + commandLog.length
        };
        return {
          message: '已打开普通人工窗口；该窗口不接收自动化命令',
          value: { id: 901, type: 'normal', automation: false }
        };
      });
    },
    manualUpdate(task, status) {
      return runCommand('manual-update', { task, status }, async () => {
        if (!['resolved', 'unresolved'].includes(status)) {
          throw codedError('manual_status_invalid');
        }
        const row = findRow(task);
        row.manualResolution = {
          status,
          updatedAt: 74000 + commandLog.length
        };
        return {
          message: status === 'resolved'
            ? '人工处置已标记为已处理'
            : '人工处置已标记为仍未解决'
        };
      });
    },
    focusTab(task) {
      return runCommand('focus-tab', { task }, async () => {
        findRow(task);
        return { message: `已聚焦 worker 标签页：序号 ${task.urlIndex}` };
      });
    },
    export() {
      return runCommand('export', {}, async () => ({
        message: `已导出 ${snapshot.rows.length} 条确定性 fixture 结果`,
        value: {
          fileName: `${snapshot.batchId || 'empty'}-fixture.csv`,
          rowCount: snapshot.rows.length
        }
      }));
    },
    exportDiagnostics() {
      return runCommand('export-diagnostics', {}, async () => ({
        message: `已导出 ${snapshot.rows.length} 条任务的 fixture 诊断日志`,
        value: {
          fileName: `${snapshot.batchId || 'empty'}-diagnostics.json`,
          taskCount: snapshot.rows.length
        }
      }));
    }
  };

  return { application, controller };
}
