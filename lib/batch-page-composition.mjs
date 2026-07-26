import { bootAppShell } from './app-shell.mjs';
import { createBatchCommandController } from './batch-command-controller.mjs';
import { createBatchConsoleSnapshot } from './batch-console-state.mjs';
import { createBatchConsoleView } from './batch-console-view.mjs';
import {
  decodeBatchCsv,
  parseBatchCsv,
  preflightBatchRows
} from './batch-preflight.mjs';
import { createDefaultBatchAssignment } from './batch-profile-contract.mjs';
import { getBatchStartError } from './batch-readiness.mjs';
import { createBatchWizardView } from './batch-wizard-view.mjs';
import { createBatchWorkerRuntime } from './batch-worker-runtime.mjs';

const EMPTY_FILTERS = Object.freeze({
  status: 'all',
  domain: 'all',
  timeRange: 'all',
  keyword: ''
});
const SENSITIVE_KEY = /(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|credential)/i;
const PAGE_INSTANCES = new WeakMap();

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeCode(error, fallback = 'batch_command_failed') {
  const code = String(error?.code || error || '');
  return /^[a-z0-9_:-]{1,80}$/i.test(code) ? code : fallback;
}

function defaultBatchId() {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === 'function') return randomUuid.call(globalThis.crypto);
  return `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function draftFromSettings(settings, assignment) {
  return {
    step: 1,
    assignment,
    preflight: null,
    settings: {
      autoOpenPanel: settings.autoOpenPanel === true,
      autoGenerate: settings.autoGenerate !== false,
      autoSubmit: settings.autoSubmit === true,
      concurrency: settings.concurrency,
      timeoutSeconds: settings.timeoutSeconds
    },
    readinessError: '',
    parseError: ''
  };
}

function restoreDraft(savedDraft, settings, assignment) {
  const defaults = draftFromSettings(settings, assignment);
  if (!savedDraft || typeof savedDraft !== 'object') return defaults;
  return {
    ...defaults,
    ...savedDraft,
    assignment,
    settings: {
      ...defaults.settings,
      ...(savedDraft.settings || {})
    }
  };
}

function startPayloadFromDraft(draft, createBatchId) {
  const includedRows = (draft?.preflight?.rows || []).filter((row) => (
    row?.included === true &&
    (row.status === 'eligible' || row.status === 'duplicate')
  ));
  if (includedRows.length === 0) throw codedError('batch_source_empty');
  const parsedUrls = includedRows.map((row, originalIndex) => ({
    originalIndex,
    url: row.url,
    sourceDomain: row.sourceDomain || '',
    originalRow: [...row.originalRow]
  }));
  return {
    batchId: createBatchId(),
    source: {
      fileName: draft.fileName || 'targets.csv',
      headers: [...draft.preflight.headers],
      rows: parsedUrls.map((item) => [...item.originalRow]),
      parsedUrls
    },
    settings: {
      ...draft.settings,
      assignment: structuredClone(draft.assignment)
    }
  };
}

function csvValue(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportResultText(result) {
  if (result === 'success' || result === 'skipped') return '√';
  if (result === 'manual_required') return '需手动处理';
  if (result === 'blocked_illegal') return '非法站点，已拦截';
  return '×';
}

export function exportBatchResultsCsv(documentRef, checkpoint, legacyResults) {
  const checkpointResults = checkpoint && Array.isArray(checkpoint.results)
    ? checkpoint.results
    : null;
  const results = checkpointResults || (
    Array.isArray(legacyResults?.results) ? legacyResults.results : []
  );
  if (results.length === 0) return false;
  const sourceHeaders = checkpointResults
    ? checkpoint?.source?.headers || []
    : [];
  const inferredLength = results.find((item) => (
    Array.isArray(item?.originalRow) && item.originalRow.length > 0
  ))?.originalRow?.length || 0;
  const headers = sourceHeaders.length > 0
    ? sourceHeaders
    : Array.from({ length: inferredLength }, (_, index) => `列${index + 1}`);
  const sensitiveColumns = new Set(headers.flatMap((header, index) => (
    SENSITIVE_KEY.test(String(header)) ? [index] : []
  )));
  const lines = [
    [...headers, '运行结果'].map(csvValue).join(','),
    ...results.map((result) => [
      ...Array.from({ length: headers.length }, (_, index) => (
        sensitiveColumns.has(index)
          ? '[REDACTED]'
          : result?.originalRow?.[index] ?? ''
      )),
      exportResultText(result?.result)
    ].map(csvValue).join(','))
  ];
  const view = documentRef.defaultView;
  const BlobConstructor = view?.Blob || globalThis.Blob;
  const urlApi = view?.URL || globalThis.URL;
  if (
    typeof BlobConstructor !== 'function' ||
    typeof urlApi?.createObjectURL !== 'function'
  ) {
    return false;
  }
  const blob = new BlobConstructor(
    [`\ufeff${lines.join('\n')}`],
    { type: 'text/csv;charset=utf-8' }
  );
  const objectUrl = urlApi.createObjectURL(blob);
  const anchor = documentRef.createElement('a');
  anchor.href = objectUrl;
  anchor.download = `batch_result_${checkpoint?.batchId || legacyResults?.batchId || 'local'}.csv`;
  documentRef.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  urlApi.revokeObjectURL(objectUrl);
  return true;
}

function requireDependencies(dependencies) {
  for (const name of [
    'runtimeRequest',
    'tabsApi',
    'getConsoleWindowId',
    'manualWindows',
    'loadBatchSettings',
    'loadLlmConfig'
  ]) {
    if (typeof dependencies?.[name] !== 'function' && !dependencies?.[name]) {
      throw codedError(`batch_dependency_${name}_missing`);
    }
  }
}

async function bootBatchPageInstance(documentRef, dependencies) {
  if (!documentRef?.querySelector) throw codedError('batch_document_missing');
  requireDependencies(dependencies);
  let shellMount = null;
  const initialConsoleMount = documentRef.querySelector('[data-batch-console]');
  const initialWizardMount = documentRef.querySelector('[data-batch-wizard]');
  if (!initialConsoleMount) throw codedError('batch_console_mount_missing');
  if (!initialWizardMount) throw codedError('batch_wizard_mount_missing');

  const [
    loaded,
    settings,
    llmConfig,
    savedDraft,
    legacyResults,
    consoleWindowId
  ] = await Promise.all([
    dependencies.runtimeRequest('BATCH_SESSION_LOAD_FOR_PAGE'),
    dependencies.loadBatchSettings(),
    dependencies.loadLlmConfig(),
    dependencies.draftStorage?.get?.() ?? null,
    dependencies.loadLegacyResults?.() ?? null,
    dependencies.getConsoleWindowId()
  ]);
  if (!loaded?.ok) {
    throw codedError(loaded?.error || 'batch_runtime_failed');
  }

  const timers = dependencies.timers || documentRef.defaultView || globalThis;
  const onlineTarget = dependencies.onlineTarget || documentRef.defaultView;
  const assignment = createDefaultBatchAssignment(settings);
  const defaultDraft = restoreDraft(savedDraft, settings, assignment);
  let checkpoint = loaded.checkpoint || null;
  let filters = { ...EMPTY_FILTERS };
  let online = typeof dependencies.isOnline === 'function'
    ? dependencies.isOnline() !== false
    : onlineTarget?.navigator?.onLine !== false;
  let inFlight = null;
  let commandResult = '';
  let runtimeError = null;
  let historyPendingState = 'idle';
  let historyPendingCount = 0;
  let retentionStatus = null;
  let destroyed = false;
  let runtimeInitialized = false;
  let renderTimer = null;
  let commandController;
  let consoleView;
  let wizardView;

  const coreWorkerRuntime = createBatchWorkerRuntime({
    tabsApi: dependencies.tabsApi,
    windowId: consoleWindowId,
    runtimeRequest: dependencies.runtimeRequest,
    sealSubmitContext: dependencies.sealSubmitContext,
    timers,
    clock: dependencies.clock || Date.now,
    readinessTimeoutMs: dependencies.readinessTimeoutMs,
    readinessPollIntervalMs: dependencies.readinessPollIntervalMs,
    handleDeliveryTimeoutMs: dependencies.handleDeliveryTimeoutMs
  });
  const workerRuntime = {
    async start(nextCheckpoint) {
      runtimeInitialized = true;
      return coreWorkerRuntime.start(nextCheckpoint);
    },
    pause: (...args) => coreWorkerRuntime.pause(...args),
    async resume(nextCheckpoint) {
      if (!runtimeInitialized) {
        runtimeInitialized = true;
        await coreWorkerRuntime.start(nextCheckpoint);
        return true;
      }
      return coreWorkerRuntime.resume(nextCheckpoint);
    },
    refill: (...args) => coreWorkerRuntime.refill(...args),
    stop: (...args) => coreWorkerRuntime.stop(...args),
    focus: (...args) => coreWorkerRuntime.focus(...args),
    dispose: (...args) => coreWorkerRuntime.dispose(...args)
  };

  function historyBanners() {
    const banners = [];
    if (historyPendingState === 'pending' && historyPendingCount > 0) {
      banners.push({
        kind: 'history',
        title: '评论历史等待重试',
        message: `仍有 ${historyPendingCount} 条评论历史等待后台保存。`
      });
    } else if (historyPendingState === 'unavailable') {
      banners.push({
        kind: 'history',
        title: '评论历史状态暂不可用',
        message: '部分评论历史可能仍在等待保存，请稍后重试。'
      });
    }
    const dueSoonCount = Number(retentionStatus?.dueSoonCount) || 0;
    const expiredCount = Number(retentionStatus?.expiredCount) || 0;
    if (expiredCount > 0) {
      banners.push({
        kind: 'history',
        title: '评论历史等待归档',
        message: `有 ${expiredCount} 条评论历史已满 90 天，等待导出和确认清理。`
      });
    } else if (dueSoonCount > 0) {
      banners.push({
        kind: 'history',
        title: '评论历史即将到期',
        message: `有 ${dueSoonCount} 条评论历史即将达到 90 天，请提前归档。`
      });
    }
    return banners;
  }

  function render() {
    if (destroyed || !consoleView) return;
    consoleView.render(createBatchConsoleSnapshot(checkpoint, {
      assignment: checkpoint?.settings?.assignment || assignment,
      filters,
      online,
      inFlight,
      commandResult,
      runtimeError,
      extraBanners: historyBanners(),
      hasLegacyResults: Array.isArray(legacyResults?.results) &&
        legacyResults.results.length > 0,
      now: (dependencies.clock || Date.now)()
    }));
  }

  async function runCommand(name, operation) {
    if (destroyed) return null;
    inFlight = name;
    commandResult = '';
    runtimeError = null;
    render();
    try {
      const result = await operation();
      if (
        result?.batchId &&
        (
          checkpoint?.batchId !== result.batchId ||
          !Number.isFinite(checkpoint?.updatedAt) ||
          !Number.isFinite(result.updatedAt) ||
          result.updatedAt >= checkpoint.updatedAt
        )
      ) {
        checkpoint = result;
      }
      commandResult = `${name}_complete`;
      return result;
    } catch (error) {
      const code = safeCode(error);
      runtimeError = code;
      commandResult = code;
      return null;
    } finally {
      if (!destroyed) {
        inFlight = null;
        render();
      }
    }
  }

  commandController = createBatchCommandController({
    runtimeRequest: dependencies.runtimeRequest,
    workerRuntime,
    manualWindows: dependencies.manualWindows,
    draftStorage: dependencies.draftStorage,
    getCheckpoint: () => checkpoint
  });

  let wizardDraft = defaultDraft;
  wizardView = createBatchWizardView(documentRef, {
    onDraftChange(nextDraft) {
      wizardDraft = nextDraft;
      void dependencies.draftStorage?.set?.(nextDraft).catch(() => {});
    },
    async onParseFile(file, currentDraft) {
      try {
        const bytes = await file.arrayBuffer();
        const decoded = decodeBatchCsv(bytes);
        const parsed = parseBatchCsv(decoded, dependencies.parseCsv);
        const preflight = preflightBatchRows(parsed, {
          evaluateUrl: dependencies.evaluateUrl
        });
        wizardDraft = {
          ...currentDraft,
          fileName: file.name || 'targets.csv',
          preflight,
          parseError: ''
        };
      } catch (error) {
        wizardDraft = {
          ...currentDraft,
          preflight: null,
          parseError: safeCode(error, 'csv_parse_failed')
        };
      }
      wizardView.render(wizardDraft);
      await dependencies.draftStorage?.set?.(wizardDraft).catch(() => {});
    },
    getReadinessError(draft) {
      if (!online) return 'batch_offline';
      const count = draft?.preflight?.summary?.included || 0;
      return getBatchStartError(llmConfig, count);
    },
    onStart(draft) {
      if (!online) {
        runtimeError = 'batch_offline';
        render();
        return;
      }
      const createBatchId = dependencies.createBatchId || defaultBatchId;
      void runCommand('start', async () => {
        const started = await commandController.start(
          startPayloadFromDraft(draft, createBatchId)
        );
        wizardView.close();
        return started;
      });
    },
    onCancel(nextDraft) {
      wizardDraft = nextDraft;
    }
  });

  consoleView = createBatchConsoleView(documentRef, {
    onPause: () => void runCommand('pause', () => commandController.pause()),
    onResume: () => void runCommand('resume', () => commandController.resume()),
    onStop: (confirmed) => void runCommand(
      'stop',
      () => commandController.stop(confirmed)
    ),
    onRetry: (task, confirmed) => void runCommand(
      'retry',
      () => commandController.retry(task, confirmed)
    ),
    onOpenManual: (task) => void runCommand(
      'manual',
      () => commandController.openManual(task)
    ),
    onManualUpdate: (task, status) => void runCommand(
      `manual_${status}`,
      () => commandController.updateManual(task, status)
    ),
    onFocusTab: (task) => void runCommand(
      'focus',
      () => workerRuntime.focus(task.urlIndex)
    ),
    onFilterChange(nextFilters) {
      filters = { ...filters, ...nextFilters };
      render();
    },
    onNewBatch() {
      if (!online) {
        runtimeError = 'batch_offline';
        render();
        return;
      }
      wizardView.open(wizardDraft);
    },
    onExport() {
      const exportResults = dependencies.exportResults ||
        ((currentCheckpoint, fallback) => exportBatchResultsCsv(
          documentRef,
          currentCheckpoint,
          fallback
        ));
      exportResults(checkpoint, legacyResults);
    }
  });

  const unsubscribeCommand = commandController.subscribe((update) => {
    if (destroyed) return;
    if (update?.checkpoint) checkpoint = update.checkpoint;
    if (typeof update?.online === 'boolean') online = update.online;
    if (update?.type === 'runtime-error') {
      runtimeError = update.errorCode || 'batch_runtime_failed';
    }
    render();
  });
  const unsubscribeWorker = coreWorkerRuntime.subscribe((event) => {
    if (destroyed) return;
    if (event?.checkpoint) checkpoint = event.checkpoint;
    if (event?.type === 'runtime-error') {
      runtimeError = safeCode(event.error, 'batch_runtime_failed');
    }
    render();
  });
  const unsubscribeRuntime = dependencies.subscribeRuntimeMessages?.((message) => {
    if (destroyed) return;
    if (message?.type === 'BATCH_CONFIRMED') {
      if (Number.isInteger(message.historyPendingCount)) {
        historyPendingCount = message.historyPendingCount;
        historyPendingState = message.historyPendingCount > 0
          ? 'pending'
          : 'idle';
      } else if (
        message.historyPendingCount === null ||
        message.historySaveStatus === 'failed'
      ) {
        historyPendingState = 'unavailable';
      }
      void coreWorkerRuntime.handleConfirmation(message).then((handled) => {
        if (!handled && !destroyed) render();
      }).catch(() => {
        if (!destroyed) {
          runtimeError = 'batch_confirmation_failed';
          render();
        }
      });
      return;
    }
    if (message?.type === 'BATCH_TASK_PHASE') {
      void dependencies.runtimeRequest('BATCH_SESSION_GET').then((response) => {
        if (!destroyed && response?.ok && response.checkpoint) {
          checkpoint = response.checkpoint;
          render();
        }
      }).catch(() => {});
    }
  }) || (() => {});

  const handleOffline = () => {
    online = false;
    wizardView.render(wizardDraft);
    render();
    if (
      checkpoint?.status === 'running' ||
      inFlight === 'start' ||
      inFlight === 'resume'
    ) {
      void runCommand('offline', () => commandController.handleOffline());
    }
  };
  const handleOnline = () => {
    online = true;
    commandController.handleOnline();
    wizardView.render(wizardDraft);
    render();
  };
  onlineTarget?.addEventListener?.('offline', handleOffline);
  onlineTarget?.addEventListener?.('online', handleOnline);

  let destroyPromise = null;
  function destroy({ reason = 'page_teardown' } = {}) {
    if (destroyPromise) return destroyPromise;
    destroyPromise = (async () => {
      if (
        checkpoint?.status === 'running' ||
        inFlight === 'start' ||
        inFlight === 'resume'
      ) {
        try {
          const paused = await commandController.pause('page_teardown');
          if (paused) checkpoint = paused;
        } catch (error) {
          runtimeError = safeCode(error, 'batch_teardown_pause_failed');
        }
      }
      destroyed = true;
      if (renderTimer !== null) timers.clearInterval?.(renderTimer);
      renderTimer = null;
      unsubscribeRuntime();
      unsubscribeCommand();
      unsubscribeWorker();
      onlineTarget?.removeEventListener?.('offline', handleOffline);
      onlineTarget?.removeEventListener?.('online', handleOnline);
      commandController.detachOnlineListeners();
      wizardView.destroy();
      consoleView.destroy();
      if (shellMount) shellMount.textContent = '';
      await workerRuntime.dispose();
    })();
    return destroyPromise;
  }

  shellMount = bootAppShell(documentRef, {
    currentUrl: documentRef.location?.href,
    onNavigate(href) {
      void destroy({ reason: 'navigation' }).then(() => {
        if (typeof dependencies.navigate === 'function') {
          dependencies.navigate(href);
        } else {
          documentRef.location?.assign?.(href);
        }
      });
    }
  });

  render();
  renderTimer = timers.setInterval?.(render, 1000) ?? null;
  const loadHistoryCompatibility = async () => {
    const [pendingResponse, retentionResponse] = await Promise.all([
      dependencies.retryPendingHistoryWrites?.().catch(() => null),
      dependencies.loadHistoryRetentionStatus?.().catch(() => null)
    ]);
    if (destroyed) return;
    if (pendingResponse?.ok) {
      const pending = pendingResponse.data?.pending;
      if (Number.isInteger(pending)) {
        historyPendingCount = pending;
        historyPendingState = pending > 0 ? 'pending' : 'idle';
      } else if (pending === null) {
        historyPendingState = 'unavailable';
      }
    }
    if (retentionResponse?.ok) {
      retentionStatus = {
        dueSoonCount: Number(retentionResponse.data?.dueSoonCount) || 0,
        expiredCount: Number(retentionResponse.data?.expiredCount) || 0
      };
    }
    render();
  };
  void loadHistoryCompatibility();

  return {
    destroy
  };
}

export function bootBatchPage(documentRef, dependencies) {
  const existing = PAGE_INSTANCES.get(documentRef);
  if (existing) return existing;

  let bootPromise;
  bootPromise = bootBatchPageInstance(documentRef, dependencies)
    .then((page) => {
      const destroyPage = page.destroy;
      let releasePromise = null;
      page.destroy = (options) => {
        if (releasePromise) return releasePromise;
        releasePromise = Promise.resolve(destroyPage(options)).finally(() => {
          if (PAGE_INSTANCES.get(documentRef) === bootPromise) {
            PAGE_INSTANCES.delete(documentRef);
          }
        });
        return releasePromise;
      };
      return page;
    })
    .catch((error) => {
      if (PAGE_INSTANCES.get(documentRef) === bootPromise) {
        PAGE_INSTANCES.delete(documentRef);
      }
      throw error;
    });
  PAGE_INSTANCES.set(documentRef, bootPromise);
  return bootPromise;
}
