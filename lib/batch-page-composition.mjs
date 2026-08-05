import { bootAppShell } from './app-shell.mjs';
import { createBatchCommandController } from './batch-command-controller.mjs';
import { escapeCsvCell } from './comment-history-csv.mjs';
import {
  batchCommandMessage,
  createBatchConsoleSnapshot,
  runtimeErrorMessage
} from './batch-console-state.mjs';
import { createBatchConsoleView } from './batch-console-view.mjs';
import {
  decodeBatchCsv,
  parseBatchCsv,
  preflightBatchRows
} from './batch-preflight.mjs';
import {
  decodeBatchCsv as decodeAssignmentBatchCsv,
  inferBatchColumnMapping,
  parseBatchCsv as parseAssignmentBatchCsv
} from './batch-csv-import.mjs';
import { createBatchPlanDraftController } from './batch-plan-draft-controller.mjs';
import {
  BATCH_OUTLINK_MAPPING,
  buildBatchOutlinkParsedCsv,
  buildLegacyBatchOutlinkDocument,
  normalizeBatchOutlinkRecords
} from './batch-outlink-source.mjs';
import { createDefaultBatchAssignment } from './batch-profile-contract.mjs';
import { getBatchStartError } from './batch-readiness.mjs';
import {
  batchSkipReasonLabel,
  isRecentSuccessResult
} from './batch-result-classification.mjs';
import { createBatchWizardView } from './batch-wizard-view.mjs';
import {
  createBatchWorkerRuntime,
  isForwardRemovedTabCheckpoint
} from './batch-worker-runtime.mjs';

const EMPTY_FILTERS = Object.freeze({
  status: 'all',
  domain: 'all',
  profile: 'all',
  promotionSite: 'all',
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

function canAdoptRejectedRemovedCheckpoint(current, message) {
  return isForwardRemovedTabCheckpoint(current, message);
}

export function hasWorkerCapacityGap(checkpoint) {
  if (checkpoint?.status !== 'running') return false;
  let queued = 0;
  let active = 0;
  for (const task of Object.values(checkpoint.tasks || {})) {
    if (task?.state === 'queued') queued += 1;
    if (['active', 'submitting'].includes(task?.state)) active += 1;
  }
  const concurrency = Number(checkpoint.settings?.concurrency);
  return (
    queued > 0 &&
    Number.isInteger(concurrency) &&
    concurrency > 0 &&
    active < concurrency
  );
}

export function hasWorkerCompletionGap(checkpoint) {
  if (checkpoint?.status !== 'running') return false;
  const tasks = Object.values(checkpoint.tasks || {});
  return tasks.length > 0 &&
    tasks.every((task) => task?.state === 'terminal');
}

function hasWorkerRecoveryGap(checkpoint) {
  return hasWorkerCapacityGap(checkpoint) ||
    hasWorkerCompletionGap(checkpoint);
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
    parseError: '',
    sourceMode: 'csv',
    outlinkSource: {
      query: '',
      page: 0,
      pageSize: 50,
      total: 0,
      records: [],
      selectedRecords: [],
      loading: false,
      error: ''
    }
  };
}

function restoreDraft(savedDraft, settings, assignment) {
  const defaults = draftFromSettings(settings, assignment);
  if (!savedDraft || typeof savedDraft !== 'object') return defaults;
  return {
    ...defaults,
    ...savedDraft,
    assignment,
    outlinkSource: {
      ...defaults.outlinkSource,
      ...(savedDraft.outlinkSource || {}),
      records: []
    },
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

function startPayloadFromPlan(planState, settings) {
  if (!planState?.plan || !planState?.confirmation) {
    throw codedError('plan_confirmation_required');
  }
  if (planState.confirmation.planFingerprint !== planState.plan.planFingerprint) {
    throw codedError('plan_fingerprint_changed');
  }
  return {
    batchId: planState.plan.planId,
    plan: structuredClone(planState.plan),
    confirmation: structuredClone(planState.confirmation),
    settings: structuredClone(settings)
  };
}

function targetUrlsFromStartPayload(payload) {
  if (Array.isArray(payload?.source?.parsedUrls)) {
    return payload.source.parsedUrls.map(({ url }) => url);
  }
  if (Array.isArray(payload?.plan?.tasks)) {
    return payload.plan.tasks
      .filter((task) => task?.state === 'eligible')
      .map(({ targetUrl }) => targetUrl);
  }
  throw codedError('batch_source_empty');
}

function targetUrlsFromCheckpoint(checkpoint) {
  if (!Array.isArray(checkpoint?.source?.parsedUrls)) return [];
  return checkpoint.source.parsedUrls
    .map((item) => item?.url)
    .filter((url) => typeof url === 'string' && url.length > 0);
}

function applyPlanState(draft, domainConfig, state) {
  return {
    ...draft,
    domainConfig,
    parsedCsv: state.parsed,
    mapping: state.mapping,
    plan: state.plan,
    planSummary: state.summary,
    confirmation: state.confirmation,
    repeatOverrides: state.repeatOverrides
  };
}

function exportResultText(result) {
  if (result?.result === 'success') return '发布成功';
  if (isRecentSuccessResult(result)) return '历史已成功发布';
  if (result?.result === 'skipped') {
    return `已跳过：${batchSkipReasonLabel(result.skipReason)}`;
  }
  if (result?.result === 'manual_required') return '需手动处理';
  if (result?.result === 'blocked_illegal') return '非法站点，已拦截';
  return '×';
}

function exportResultRows(results) {
  const indexed = new Map();
  const unindexed = [];
  for (const result of results) {
    if (!Number.isInteger(result?.originalIndex)) {
      unindexed.push(result);
      continue;
    }
    const existing = indexed.get(result.originalIndex);
    const existingAttempt = Number(existing?.attempt) || 0;
    const candidateAttempt = Number(result?.attempt) || 0;
    const existingTimestamp = Number(existing?.timestamp) || 0;
    const candidateTimestamp = Number(result?.timestamp) || 0;
    if (!existing
        || candidateAttempt > existingAttempt
        || (candidateAttempt === existingAttempt
          && candidateTimestamp >= existingTimestamp)) {
      indexed.set(result.originalIndex, result);
    }
  }
  return [
    ...[...indexed.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, result]) => result),
    ...unindexed
  ];
}

function assignmentHeaderKey(value) {
  return String(value ?? '')
    .replace(/^\ufeff/u, '')
    .trim()
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replaceAll(/[\s_-]/gu, '');
}

export function exportBatchResultsCsv(documentRef, checkpoint, legacyResults) {
  const checkpointResults = checkpoint && Array.isArray(checkpoint.results)
    ? checkpoint.results
    : null;
  const allResults = checkpointResults || (
    Array.isArray(legacyResults?.results) ? legacyResults.results : []
  );
  const results = checkpointResults
    ? exportResultRows(allResults)
    : allResults;
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
  const headerKeys = new Set(headers.map(assignmentHeaderKey));
  const hasProfileReference = ['profileid', 'profile', '身份id', '身份']
    .some((key) => headerKeys.has(key));
  const hasPromotionSiteReference = [
    'promotionsiteid',
    'promotionsite',
    '推广网站id',
    '推广网站'
  ].some((key) => headerKeys.has(key));
  const assignmentHeaders = checkpoint?.version === 3
    ? [
        ...(hasProfileReference ? [] : ['Profile ID']),
        '执行身份名称',
        ...(hasPromotionSiteReference ? [] : ['Promotion Site ID']),
        '执行推广网站名称'
      ]
    : [];
  const sensitiveColumns = new Set(headers.flatMap((header, index) => (
    SENSITIVE_KEY.test(String(header)) ? [index] : []
  )));
  const lines = [
    [...headers, ...assignmentHeaders, '运行结果', '评论时间']
      .map(escapeCsvCell)
      .join(','),
    ...results.map((result) => [
      ...Array.from({ length: headers.length }, (_, index) => (
        sensitiveColumns.has(index)
          ? '[REDACTED]'
          : result?.originalRow?.[index] ?? ''
      )),
      ...(checkpoint?.version === 3
        ? [
            ...(hasProfileReference ? [] : [result?.profileId || '']),
            result?.profileDisplayName ||
              checkpoint?.profiles?.[result?.profileId]?.displayName ||
              '',
            ...(hasPromotionSiteReference
              ? []
              : [result?.promotionSiteId || '']),
            result?.promotionSiteName ||
              checkpoint?.promotionSites?.[result?.promotionSiteId]?.name ||
              ''
          ]
        : []),
      exportResultText(result),
      result?.result === 'success' &&
        Number.isFinite(result?.submittedAt ?? result?.timestamp)
        ? new Date(result.submittedAt ?? result.timestamp).toISOString()
        : ''
    ].map(escapeCsvCell).join(','))
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

export function exportBatchDiagnosticsJson(documentRef, diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return false;
  const view = documentRef.defaultView;
  const BlobConstructor = view?.Blob || globalThis.Blob;
  const urlApi = view?.URL || globalThis.URL;
  if (
    typeof BlobConstructor !== 'function' ||
    typeof urlApi?.createObjectURL !== 'function'
  ) {
    return false;
  }
  const serialized = JSON.stringify(diagnostics, null, 2);
  const blob = new BlobConstructor(
    [serialized],
    { type: 'application/json;charset=utf-8' }
  );
  const objectUrl = urlApi.createObjectURL(blob);
  const anchor = documentRef.createElement('a');
  const batchId = String(diagnostics?.batch?.batchId || 'local')
    .replace(/[^a-z0-9_.-]/gi, '_')
    .slice(0, 120);
  anchor.href = objectUrl;
  anchor.download = `batch_diagnostics_${batchId || 'local'}.json`;
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

async function loadPlanningDependency(loader, fallbackValue, errorCode) {
  if (typeof loader !== 'function') {
    return {
      value: fallbackValue,
      error: null,
      attempted: false
    };
  }
  try {
    return {
      value: await loader(),
      error: null,
      attempted: true
    };
  } catch (_) {
    return {
      value: fallbackValue,
      error: errorCode,
      attempted: true
    };
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
    consoleWindowId,
    domainConfigLoad,
    recentSuccessLoad,
    successfulTargetStatsLoad
  ] = await Promise.all([
    dependencies.runtimeRequest('BATCH_SESSION_LOAD_FOR_PAGE'),
    dependencies.loadBatchSettings(),
    dependencies.loadLlmConfig(),
    dependencies.draftStorage?.get?.() ?? null,
    dependencies.loadLegacyResults?.() ?? null,
    dependencies.getConsoleWindowId(),
    loadPlanningDependency(
      dependencies.loadDomainConfig,
      null,
      'domain_config_unavailable'
    ),
    loadPlanningDependency(
      dependencies.loadRecentSuccessUrls,
      [],
      'recent_success_history_unavailable'
    ),
    loadPlanningDependency(
      dependencies.loadSuccessfulTargetStats,
      [],
      'outlink_success_history_unavailable'
    )
  ]);
  const renderableRecovery = loaded?.ok === false &&
    loaded?.recoveryRequired === true &&
    loaded?.checkpoint?.status === 'paused_recovery';
  if (!loaded?.ok && !renderableRecovery) {
    throw codedError(loaded?.error || 'batch_runtime_failed');
  }

  const timers = dependencies.timers || documentRef.defaultView || globalThis;
  const onlineTarget = dependencies.onlineTarget || documentRef.defaultView;
  const assignment = createDefaultBatchAssignment(settings);
  let domainConfig = domainConfigLoad.value;
  let recentSuccessUrls = recentSuccessLoad.value;
  let successfulTargetStats = successfulTargetStatsLoad.value;
  let planningAvailabilityError =
    domainConfigLoad.error
    || recentSuccessLoad.error
    || successfulTargetStatsLoad.error
    || '';
  if (
    !planningAvailabilityError &&
    domainConfigLoad.attempted &&
    !domainConfig
  ) {
    planningAvailabilityError = 'domain_config_unavailable';
  }
  if (!planningAvailabilityError && !Array.isArray(recentSuccessUrls)) {
    planningAvailabilityError = 'recent_success_history_unavailable';
    recentSuccessUrls = [];
  }
  if (!planningAvailabilityError && !Array.isArray(successfulTargetStats)) {
    planningAvailabilityError = 'outlink_success_history_unavailable';
    successfulTargetStats = [];
  }
  const createPlanControllerFor = (config, successUrls, selection = {}) => (
    createBatchPlanDraftController({
      config,
      recentSuccessUrls: successUrls,
      successfulTargetStats,
      selectedProfileIds: selection.allocationSelectionInitialized
        ? selection.selectedProfileIds
        : null,
      selectedPromotionPageIds: selection.allocationSelectionInitialized
        ? selection.selectedPromotionPageIds
        : null,
      illegalSiteEvaluator: dependencies.evaluateUrl,
      illegalSiteRulesVersion: dependencies.illegalSiteRulesVersion || null,
      cryptoImpl: dependencies.cryptoImpl || globalThis.crypto,
      now: dependencies.clock || Date.now,
      createPlanId: dependencies.createBatchId || defaultBatchId
    })
  );
  let defaultDraft = restoreDraft(savedDraft, settings, assignment);
  let planController = null;
  if (planningAvailabilityError) {
    defaultDraft = {
      ...defaultDraft,
      availabilityError: planningAvailabilityError
    };
  } else if (domainConfig) {
    try {
      planController = createPlanControllerFor(
        domainConfig,
        recentSuccessUrls,
        defaultDraft
      );
    } catch (_) {
      planningAvailabilityError = 'domain_config_unavailable';
    }
    if (planController) {
      defaultDraft = {
        ...defaultDraft,
        availabilityError: '',
        domainConfig,
        preflight: null
      };
      if (savedDraft?.parsedCsv) {
        try {
          await planController.setParsedCsv(savedDraft.parsedCsv);
          if (savedDraft.mapping) {
            await planController.setMapping(savedDraft.mapping);
          }
          for (const url of savedDraft.repeatOverrides || []) {
            await planController.setRepeatOverride(url, true);
          }
          defaultDraft = applyPlanState(
            defaultDraft,
            domainConfig,
            planController.snapshot()
          );
        } catch (_) {
          defaultDraft = {
            ...defaultDraft,
            parsedCsv: savedDraft.parsedCsv,
            mapping: savedDraft.mapping || null,
            parseError: runtimeErrorMessage('saved_batch_plan_invalid')
          };
        }
      }
    } else {
      planController = null;
      defaultDraft = {
        ...defaultDraft,
        availabilityError: planningAvailabilityError,
        parsedCsv: savedDraft?.parsedCsv || null,
        mapping: savedDraft?.mapping || null
      };
    }
  } else {
    defaultDraft = {
      ...defaultDraft,
      availabilityError: ''
    };
  }
  let checkpoint = loaded.checkpoint || null;
  let filters = { ...EMPTY_FILTERS };
  let online = typeof dependencies.isOnline === 'function'
    ? dependencies.isOnline() !== false
    : onlineTarget?.navigator?.onLine !== false;
  let inFlight = null;
  let commandResult = '';
  let runtimeError = renderableRecovery
    ? loaded.error || 'batch_runtime_failed'
    : null;
  let focusRuntimeError = false;
  let historyPendingState = 'idle';
  let historyPendingCount = 0;
  let retentionStatus = null;
  let destroyed = false;
  let runtimeInitialized = false;
  let renderTimer = null;
  let capacityGapTicks = 0;
  let authoritativeReconcile = null;
  let teardownPending = false;
  const activeCommands = new Set();
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
    reconcile: (...args) => coreWorkerRuntime.reconcile(...args),
    stop: (...args) => coreWorkerRuntime.stop(...args),
    focus: (...args) => coreWorkerRuntime.focus(...args),
    dispose: (...args) => coreWorkerRuntime.dispose(...args),
    quiesce: (...args) => coreWorkerRuntime.quiesce(...args),
    retainAfterFailedBackgroundTeardown: (...args) => (
      coreWorkerRuntime.retainAfterFailedBackgroundTeardown(...args)
    ),
    disposeAfterBackgroundTeardown: (...args) => (
      coreWorkerRuntime.disposeAfterBackgroundTeardown(...args)
    )
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

  async function reconcileLatestAuthoritativeCheckpoint() {
    if (authoritativeReconcile) return authoritativeReconcile;
    authoritativeReconcile = (async () => {
      const response = await dependencies.runtimeRequest(
        'BATCH_SESSION_GET'
      ).catch(() => null);
      const latest = response?.ok ? response.checkpoint : null;
      if (
        destroyed ||
        !latest?.batchId ||
        latest.batchId !== checkpoint?.batchId
      ) {
        return false;
      }
      const accepted = hasWorkerRecoveryGap(latest) &&
        typeof coreWorkerRuntime.recoverCapacity === 'function'
        ? await coreWorkerRuntime.recoverCapacity(latest)
          .catch(() => false)
        : await coreWorkerRuntime.reconcile(latest)
          .catch(() => false);
      if (accepted && !destroyed) {
        checkpoint = latest;
        runtimeError = null;
        render();
      }
      return accepted;
    })();
    try {
      return await authoritativeReconcile;
    } finally {
      authoritativeReconcile = null;
    }
  }

  function renderAndHealWorkerCapacity() {
    render();
    if (!hasWorkerRecoveryGap(checkpoint)) {
      capacityGapTicks = 0;
      return;
    }
    capacityGapTicks += 1;
    if (capacityGapTicks < 3) return;
    capacityGapTicks = 0;
    void reconcileLatestAuthoritativeCheckpoint();
  }

  async function runCommand(name, operation) {
    if (destroyed || teardownPending) return null;
    let markSettled;
    const commandSettled = new Promise((resolve) => {
      markSettled = resolve;
    });
    activeCommands.add(commandSettled);
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
      commandResult = batchCommandMessage(name);
      return result;
    } catch (error) {
      const code = safeCode(error);
      runtimeError = code;
      commandResult = runtimeErrorMessage(code);
      return null;
    } finally {
      activeCommands.delete(commandSettled);
      markSettled();
      if (!destroyed) {
        inFlight = null;
        render();
        if (focusRuntimeError) {
          focusRuntimeError = false;
          documentRef.querySelector('[data-runtime-error]')?.focus();
        }
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
  let outlinkLoadRevision = 0;
  let outlinkSelectionRevision = 0;

  async function loadOutlinkPage({ query = '', page = 0 } = {}) {
    const revision = ++outlinkLoadRevision;
    const pageSize = Number(wizardDraft.outlinkSource?.pageSize) || 50;
    const safePage = Number.isInteger(page) && page >= 0 ? page : 0;
    wizardDraft = {
      ...wizardDraft,
      outlinkSource: {
        ...(wizardDraft.outlinkSource || {}),
        query: String(query || '').trim(),
        page: safePage,
        pageSize,
        loading: true,
        error: ''
      }
    };
    wizardView.render(wizardDraft);
    try {
      const response = await dependencies.runtimeRequest('OUTLINKS_LIST', {
        filter: { keyword: wizardDraft.outlinkSource.query },
        offset: safePage * pageSize,
        limit: pageSize
      });
      if (!response?.ok || !Array.isArray(response.data?.records)) {
        throw codedError(response?.error?.code || 'outlink_records_load_failed');
      }
      if (revision !== outlinkLoadRevision) return;
      wizardDraft = {
        ...wizardDraft,
        outlinkSource: {
          ...wizardDraft.outlinkSource,
          records: normalizeBatchOutlinkRecords(response.data.records),
          total: Number.isInteger(response.data.total)
            ? Math.max(0, response.data.total)
            : 0,
          loading: false,
          error: ''
        }
      };
    } catch (_) {
      if (revision !== outlinkLoadRevision) return;
      wizardDraft = {
        ...wizardDraft,
        outlinkSource: {
          ...wizardDraft.outlinkSource,
          records: [],
          total: 0,
          loading: false,
          error: '读取已保存外链失败，请重试。'
        }
      };
    }
    wizardView.render(wizardDraft);
    await dependencies.draftStorage?.set?.(wizardDraft).catch(() => {});
  }

  async function applyOutlinkSelection(selectedRecords, currentDraft) {
    const revision = ++outlinkSelectionRevision;
    const selected = normalizeBatchOutlinkRecords(selectedRecords);
    const baseDraft = {
      ...currentDraft,
      sourceMode: 'outlinks',
      fileName: 'saved-outlinks.csv',
      outlinkSource: {
        ...currentDraft.outlinkSource,
        selectedRecords: selected
      },
      preflight: null,
      parseError: '',
      confirmationChecks: {
        normalConfirmed: false,
        highRiskConfirmed: false
      }
    };
    try {
      if (planController) {
        let planState;
        if (selected.length === 0) {
          planState = planController.clearSource();
        } else {
          await planController.setParsedCsv(buildBatchOutlinkParsedCsv(selected));
          planState = await planController.setMapping(BATCH_OUTLINK_MAPPING);
        }
        if (revision !== outlinkSelectionRevision) return;
        wizardDraft = applyPlanState(baseDraft, domainConfig, planState);
      } else {
        const preflight = preflightBatchRows(
          buildLegacyBatchOutlinkDocument(selected),
          { evaluateUrl: dependencies.evaluateUrl }
        );
        wizardDraft = {
          ...baseDraft,
          preflight,
          parsedCsv: null,
          mapping: null,
          plan: null,
          planSummary: null,
          confirmation: null
        };
      }
    } catch (error) {
      if (revision !== outlinkSelectionRevision) return;
      wizardDraft = {
        ...baseDraft,
        parsedCsv: null,
        mapping: null,
        plan: null,
        planSummary: null,
        confirmation: null,
        parseError: runtimeErrorMessage(
          safeCode(error, 'outlink_selection_invalid')
        )
      };
    }
    wizardView.render(wizardDraft);
    await dependencies.draftStorage?.set?.(wizardDraft).catch(() => {});
  }

  async function retryPlanningLoad(currentDraft) {
    const [
      nextDomainConfigLoad,
      nextRecentSuccessLoad,
      nextSuccessfulTargetStatsLoad
    ] = await Promise.all([
      loadPlanningDependency(
        dependencies.loadDomainConfig,
        null,
        'domain_config_unavailable'
      ),
      loadPlanningDependency(
        dependencies.loadRecentSuccessUrls,
        [],
        'recent_success_history_unavailable'
      ),
      loadPlanningDependency(
        dependencies.loadSuccessfulTargetStats,
        [],
        'outlink_success_history_unavailable'
      )
    ]);
    const loadError = nextDomainConfigLoad.error ||
      nextRecentSuccessLoad.error ||
      nextSuccessfulTargetStatsLoad.error ||
      (nextDomainConfigLoad.attempted && !nextDomainConfigLoad.value
        ? 'domain_config_unavailable'
        : '') ||
      (!Array.isArray(nextRecentSuccessLoad.value)
        ? 'recent_success_history_unavailable'
        : '') ||
      (!Array.isArray(nextSuccessfulTargetStatsLoad.value)
        ? 'outlink_success_history_unavailable'
        : '');
    if (loadError) {
      planningAvailabilityError = loadError;
      wizardDraft = {
        ...currentDraft,
        availabilityError: loadError
      };
      wizardView.render(wizardDraft);
      await dependencies.draftStorage?.set?.(wizardDraft).catch(() => {});
      return false;
    }

    planningAvailabilityError = '';
    domainConfig = nextDomainConfigLoad.value;
    recentSuccessUrls = nextRecentSuccessLoad.value;
    successfulTargetStats = nextSuccessfulTargetStatsLoad.value;
    planController = domainConfig
      ? createPlanControllerFor(domainConfig, recentSuccessUrls, currentDraft)
      : null;
    wizardDraft = {
      ...currentDraft,
      availabilityError: '',
      domainConfig: domainConfig || null,
      plan: null,
      planSummary: null,
      confirmation: null,
      confirmationChecks: {
        normalConfirmed: false,
        highRiskConfirmed: false
      }
    };
    if (planController && currentDraft?.parsedCsv) {
      try {
        await planController.setParsedCsv(currentDraft.parsedCsv);
        if (currentDraft.mapping) {
          await planController.setMapping(currentDraft.mapping);
        }
        for (const url of currentDraft.repeatOverrides || []) {
          await planController.setRepeatOverride(url, true);
        }
        wizardDraft = applyPlanState(
          wizardDraft,
          domainConfig,
          planController.snapshot()
        );
      } catch (_) {
        wizardDraft = {
          ...wizardDraft,
          parseError: runtimeErrorMessage('saved_batch_plan_invalid')
        };
      }
    }
    runtimeError = null;
    wizardView.render(wizardDraft);
    await dependencies.draftStorage?.set?.(wizardDraft).catch(() => {});
    render();
    return true;
  }

  async function startBatch(draft, commandName = 'start') {
    if (!online) {
      runtimeError = 'batch_offline';
      render();
      return null;
    }
    const createBatchId = dependencies.createBatchId || defaultBatchId;
    let startPayload;
    let permissionRequest;
    try {
      startPayload = planController
        ? startPayloadFromPlan(planController.snapshot(), draft.settings)
        : startPayloadFromDraft(draft, createBatchId);
      permissionRequest = dependencies.requestTargetPermissions
        ? dependencies.requestTargetPermissions(
            targetUrlsFromStartPayload(startPayload)
          )
        : Promise.resolve(true);
    } catch (error) {
      permissionRequest = Promise.reject(error);
    }
    return runCommand(commandName, async () => {
      try {
        await permissionRequest;
        const started = await commandController.start(startPayload);
        wizardView.close();
        return started;
      } catch (error) {
        if (safeCode(error) === 'batch_ownership_active') {
          wizardView.close({ restoreFocus: false });
          focusRuntimeError = true;
        }
        throw error;
      }
    });
  }

  function resumeBatch(commandName = 'resume') {
    let permissionRequest;
    try {
      permissionRequest = dependencies.requestTargetPermissions
        ? dependencies.requestTargetPermissions(
            targetUrlsFromCheckpoint(checkpoint)
          )
        : Promise.resolve(true);
    } catch (error) {
      permissionRequest = Promise.reject(error);
    }
    return runCommand(commandName, async () => {
      await permissionRequest;
      return commandController.resume();
    });
  }

  wizardView = createBatchWizardView(documentRef, {
    onDraftChange(nextDraft) {
      wizardDraft = nextDraft;
      void dependencies.draftStorage?.set?.(nextDraft).catch(() => {});
    },
    async onSourceModeChange(sourceMode, currentDraft) {
      outlinkLoadRevision += 1;
      outlinkSelectionRevision += 1;
      if (planController) planController.clearSource();
      wizardDraft = {
        ...currentDraft,
        sourceMode,
        preflight: null,
        parsedCsv: null,
        mapping: null,
        plan: null,
        planSummary: null,
        confirmation: null,
        repeatOverrides: [],
        fileName: '',
        parseError: ''
      };
      wizardView.render(wizardDraft);
      await dependencies.draftStorage?.set?.(wizardDraft).catch(() => {});
      if (sourceMode === 'outlinks') {
        if (wizardDraft.outlinkSource?.selectedRecords?.length > 0) {
          await applyOutlinkSelection(
            wizardDraft.outlinkSource.selectedRecords,
            wizardDraft
          );
        }
        await loadOutlinkPage({
          query: wizardDraft.outlinkSource?.query || '',
          page: 0
        });
      }
    },
    onOutlinkLoad(request) {
      void loadOutlinkPage(request);
    },
    onOutlinkSelectionChange(selectedRecords, currentDraft) {
      void applyOutlinkSelection(selectedRecords, currentDraft);
    },
    async onParseFile(file, currentDraft) {
      try {
        const bytes = await file.arrayBuffer();
        const decoded = planController
          ? decodeAssignmentBatchCsv(bytes)
          : decodeBatchCsv(bytes);
        if (planController) {
          const parsed = parseAssignmentBatchCsv(decoded, dependencies.parseCsv);
          const mapping = inferBatchColumnMapping(parsed.headers);
          await planController.setParsedCsv(parsed);
          const planState = await planController.setMapping(mapping);
          wizardDraft = applyPlanState({
            ...currentDraft,
            fileName: file.name || 'targets.csv',
            parseError: '',
            confirmationChecks: {
              normalConfirmed: false,
              highRiskConfirmed: false
            }
          }, domainConfig, planState);
        } else {
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
        }
      } catch (error) {
        wizardDraft = {
          ...currentDraft,
          parsedCsv: null,
          mapping: null,
          plan: null,
          planSummary: null,
          confirmation: null,
          preflight: null,
          parseError: runtimeErrorMessage(
            safeCode(error, 'csv_parse_failed')
          )
        };
      }
      wizardView.render(wizardDraft);
      await dependencies.draftStorage?.set?.(wizardDraft).catch(() => {});
    },
    getReadinessError(draft) {
      if (draft?.availabilityError) {
        return runtimeErrorMessage(draft.availabilityError);
      }
      if (!online) return runtimeErrorMessage('batch_offline');
      const count = draft?.planSummary?.status?.eligible
        ?? draft?.preflight?.summary?.included
        ?? 0;
      return getBatchStartError(llmConfig, count);
    },
    getAvailabilityError(draft) {
      return runtimeErrorMessage(
        draft?.availabilityError || planningAvailabilityError
      );
    },
    onRetryPlanningLoad(currentDraft) {
      void retryPlanningLoad(currentDraft).catch(() => {
        planningAvailabilityError = 'domain_config_unavailable';
        wizardDraft = {
          ...currentDraft,
          availabilityError: planningAvailabilityError
        };
        wizardView.render(wizardDraft);
      });
    },
    async onMappingChange(mapping, currentDraft) {
      if (!planController) return;
      try {
        const planState = await planController.setMapping(mapping);
        wizardDraft = applyPlanState({
          ...currentDraft,
          parseError: '',
          confirmationChecks: {
            normalConfirmed: false,
            highRiskConfirmed: false
          }
        }, domainConfig, planState);
      } catch (error) {
        wizardDraft = {
          ...currentDraft,
          plan: null,
          planSummary: null,
          confirmation: null,
          parseError: runtimeErrorMessage(
            safeCode(error, 'invalid_column_mapping')
          )
        };
      }
      wizardView.render(wizardDraft);
      await dependencies.draftStorage?.set?.(wizardDraft).catch(() => {});
    },
    async onAllocationSelectionChange(selection, currentDraft) {
      if (!planController) return;
      try {
        const planState = await planController.setAllocationSelection({
          profileIds: selection.selectedProfileIds,
          promotionPageIds: selection.selectedPromotionPageIds
        });
        wizardDraft = applyPlanState({
          ...currentDraft,
          allocationSelectionInitialized: true,
          confirmationChecks: {
            normalConfirmed: false,
            highRiskConfirmed: false
          }
        }, domainConfig, planState);
      } catch (error) {
        wizardDraft = {
          ...currentDraft,
          plan: null,
          planSummary: null,
          confirmation: null,
          parseError: runtimeErrorMessage(
            safeCode(error, 'invalid_allocation_selection')
          )
        };
      }
      wizardView.render(wizardDraft);
      await dependencies.draftStorage?.set?.(wizardDraft).catch(() => {});
    },
    async onRepeatOverride(url, included, currentDraft) {
      if (!planController) return;
      try {
        const changed = await planController.setRepeatOverride(url, included);
        if (changed === false) return;
        wizardDraft = applyPlanState({
          ...currentDraft,
          confirmationChecks: {
            normalConfirmed: false,
            highRiskConfirmed: false
          }
        }, domainConfig, changed);
        wizardView.render(wizardDraft);
        await dependencies.draftStorage?.set?.(wizardDraft).catch(() => {});
      } catch (error) {
        runtimeError = safeCode(error, 'repeat_override_failed');
        render();
      }
    },
    async onConfirmationChange(checks, currentDraft) {
      if (!planController) return;
      try {
        const planState = planController.confirm(checks);
        wizardDraft = applyPlanState({
          ...currentDraft,
          confirmationChecks: checks
        }, domainConfig, planState);
      } catch (error) {
        wizardDraft = {
          ...currentDraft,
          confirmation: null,
          parseError: runtimeErrorMessage(
            safeCode(error, 'plan_confirmation_failed')
          )
        };
      }
      wizardView.render(wizardDraft);
      await dependencies.draftStorage?.set?.(wizardDraft).catch(() => {});
    },
    onStart(draft) {
      void startBatch(draft);
    },
    onCancel(nextDraft) {
      wizardDraft = nextDraft;
    }
  });

  consoleView = createBatchConsoleView(documentRef, {
    onPause: () => void runCommand('pause', () => commandController.pause()),
    onRetryPersistence: () => void runCommand(
      'retry-persistence',
      () => commandController.retryPersistence()
    ),
    onResume: () => void resumeBatch(),
    onStop: (confirmed) => void runCommand(
      'stop',
      () => commandController.stop(confirmed)
    ),
    onRetry(task, confirmed) {
      let permissionRequest;
      try {
        permissionRequest = dependencies.requestTargetPermissions
          ? dependencies.requestTargetPermissions([task.url])
          : Promise.resolve(true);
      } catch (error) {
        permissionRequest = Promise.reject(error);
      }
      void runCommand('retry', async () => {
        await permissionRequest;
        return commandController.retry(task, confirmed);
      });
    },
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
      if (
        wizardDraft.sourceMode === 'outlinks'
        && wizardDraft.outlinkSource?.records?.length === 0
        && wizardDraft.outlinkSource?.loading !== true
      ) {
        void loadOutlinkPage({
          query: wizardDraft.outlinkSource?.query || '',
          page: wizardDraft.outlinkSource?.page || 0
        });
      }
    },
    onExport() {
      const exportResults = dependencies.exportResults ||
        ((currentCheckpoint, fallback) => exportBatchResultsCsv(
          documentRef,
          currentCheckpoint,
          fallback
        ));
      exportResults(checkpoint, legacyResults);
    },
    onExportDiagnostics() {
      void dependencies.runtimeRequest('BATCH_DIAGNOSTICS_EXPORT', {
        batchId: checkpoint?.batchId
      }).then((response) => {
        if (!response?.ok || !response.diagnostics) {
          throw codedError(
            response?.error || 'batch_diagnostic_export_failed'
          );
        }
        const exportDiagnostics = dependencies.exportDiagnostics ||
          ((payload) => exportBatchDiagnosticsJson(documentRef, payload));
        if (!exportDiagnostics(response.diagnostics)) {
          throw codedError('batch_diagnostic_export_failed');
        }
      }).catch((error) => {
        runtimeError = safeCode(error, 'batch_diagnostic_export_failed');
        render();
      });
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
    } else if (
      event?.transition === 'BATCH_WORKER_TAB_REMOVED' &&
      event?.recovered === true
    ) {
      runtimeError = null;
    }
    render();
  });
  const unsubscribeRuntime = dependencies.subscribeRuntimeMessages?.((message) => {
    if (destroyed) return;
    if (message?.type === 'BATCH_WORKER_TAB_REMOVED') {
      void coreWorkerRuntime.acceptRemovedTabCheckpoint(message)
        .then(async (accepted) => {
          if (
            !accepted &&
            canAdoptRejectedRemovedCheckpoint(checkpoint, message)
          ) {
            checkpoint = message.checkpoint;
            render();
          }
          if (!accepted) {
            await reconcileLatestAuthoritativeCheckpoint();
          }
        })
        .catch(() => {
          runtimeError = 'worker_tab_reconcile_failed';
          render();
        });
      return;
    }
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
      void dependencies.runtimeRequest('BATCH_SESSION_GET').catch(() => null)
        .then((response) => coreWorkerRuntime.handleConfirmation({
          ...message,
          ...(response?.ok && response.checkpoint
            ? { checkpoint: response.checkpoint }
            : {})
        })).then(async (handled) => {
        if (!handled) {
          await reconcileLatestAuthoritativeCheckpoint();
        }
        if (!handled && !destroyed) render();
      }).catch(() => {
        if (!destroyed) {
          runtimeError = 'batch_confirmation_failed';
          render();
        }
      });
      return;
    }
    if (message?.type === 'BATCH_TASK_PHASE_UPDATED') {
      void dependencies.runtimeRequest('BATCH_SESSION_GET').then((response) => {
        if (!destroyed && response?.ok && response.checkpoint) {
          checkpoint = response.checkpoint;
          render();
        }
      }).catch(() => {});
    }
  }) || (() => {});

  function localDebugPageStatus() {
    return {
      batchId: checkpoint?.batchId || null,
      status: checkpoint?.status || null,
      updatedAt: Number.isFinite(checkpoint?.updatedAt)
        ? checkpoint.updatedAt
        : null,
      inFlight,
      runtimeError,
      online,
      runtimeInitialized
    };
  }

  const unsubscribeLocalDebug = dependencies.subscribeLocalDebugCommands?.(
    async ({ command, batchId, confirmPermanent }) => {
      if (destroyed || teardownPending) {
        return { ok: false, error: 'batch_page_unavailable' };
      }
      if (command === 'status') {
        return { ok: true, page: localDebugPageStatus() };
      }
      if (!checkpoint?.batchId) {
        if (command !== 'start') {
          return { ok: false, error: 'batch_not_initialized' };
        }
      }
      if (command === 'start') {
        if (checkpoint?.status === 'running') {
          return { ok: true, page: localDebugPageStatus() };
        }
        const started = checkpoint?.status === 'paused_recovery'
          ? await resumeBatch('local_control_start')
          : await startBatch(wizardDraft, 'local_control_start');
        return started
          ? { ok: true, page: localDebugPageStatus() }
          : {
              ok: false,
              error: runtimeError || 'batch_start_failed',
              page: localDebugPageStatus()
            };
      }
      if (command === 'pause') {
        const paused = await runCommand(
          'local_debug_pause',
          () => commandController.pause()
        );
        return paused
          ? { ok: true, page: localDebugPageStatus() }
          : {
              ok: false,
              error: runtimeError || 'batch_pause_failed',
              page: localDebugPageStatus()
            };
      }
      if (command === 'resume') {
        const resumed = await resumeBatch('local_debug_resume');
        return resumed
          ? { ok: true, page: localDebugPageStatus() }
          : {
              ok: false,
              error: runtimeError || 'batch_resume_failed',
              page: localDebugPageStatus()
            };
      }
      if (command === 'stop') {
        if (
          confirmPermanent !== true ||
          typeof batchId !== 'string' ||
          batchId !== checkpoint.batchId
        ) {
          return {
            ok: false,
            error: confirmPermanent === true
              ? 'stale_batch'
              : 'stop_confirmation_required',
            page: localDebugPageStatus()
          };
        }
        const stopped = await runCommand(
          'local_control_stop',
          () => commandController.stop(true)
        );
        return stopped
          ? { ok: true, page: localDebugPageStatus() }
          : {
              ok: false,
              error: runtimeError || 'batch_stop_failed',
              page: localDebugPageStatus()
            };
      }
      if (command === 'reconcile') {
        const reconciled = await runCommand(
          'local_debug_reconcile',
          async () => {
            const response = await dependencies.runtimeRequest(
              'BATCH_SESSION_GET'
            );
            if (!response?.ok || !response.checkpoint) {
              throw codedError(response?.error || 'batch_status_failed');
            }
            if (response.checkpoint.batchId !== checkpoint.batchId) {
              throw codedError('batch_runtime_stale_checkpoint');
            }
            const accepted = await workerRuntime.reconcile(
              response.checkpoint
            );
            if (!accepted) throw codedError('worker_reconcile_rejected');
            return response.checkpoint;
          }
        );
        return reconciled
          ? { ok: true, page: localDebugPageStatus() }
          : {
              ok: false,
              error: runtimeError || 'worker_reconcile_rejected',
              page: localDebugPageStatus()
            };
      }
      return { ok: false, error: 'local_debug_command_forbidden' };
    }
  ) || (() => {});

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
      teardownPending = true;
      commandController.beginTeardown(reason);
      workerRuntime.quiesce();
      await Promise.all([...activeCommands]);
      const response = await dependencies.runtimeRequest(
        'BATCH_PAGE_TEARDOWN',
        {
          ...(checkpoint?.batchId ? { batchId: checkpoint.batchId } : {}),
          reason
        }
      ).catch((error) => ({
        ok: false,
        error: safeCode(error, 'batch_teardown_failed'),
        checkpoint
      }));
      if (!response?.ok || response.cleanupComplete !== true) {
        workerRuntime.retainAfterFailedBackgroundTeardown();
        const persisted = response?.checkpoint || checkpoint;
        if (persisted) {
          checkpoint = {
            ...persisted,
            status: 'paused_recovery',
            persistencePending:
              response?.error === 'checkpoint_write_failed',
            lastPersistedStatus: persisted.status
          };
        }
        runtimeError = response?.error || 'batch_teardown_failed';
        teardownPending = false;
        render();
        return false;
      }
      if (response.checkpoint) checkpoint = response.checkpoint;
      const disposed = await workerRuntime.disposeAfterBackgroundTeardown();
      if (disposed === false) {
        runtimeError = 'batch_teardown_cleanup_failed';
        teardownPending = false;
        render();
        return false;
      }
      destroyed = true;
      if (renderTimer !== null) timers.clearInterval?.(renderTimer);
      renderTimer = null;
      unsubscribeRuntime();
      unsubscribeLocalDebug();
      unsubscribeCommand();
      unsubscribeWorker();
      onlineTarget?.removeEventListener?.('offline', handleOffline);
      onlineTarget?.removeEventListener?.('online', handleOnline);
      commandController.detachOnlineListeners();
      wizardView.destroy();
      consoleView.destroy();
      if (shellMount) shellMount.textContent = '';
      return true;
    })();
    destroyPromise = destroyPromise.then(
      (completed) => {
        if (!completed) destroyPromise = null;
        return completed;
      },
      (error) => {
        destroyPromise = null;
        teardownPending = false;
        throw error;
      }
    );
    return destroyPromise;
  }

  shellMount = bootAppShell(documentRef, {
    currentUrl: documentRef.location?.href,
    onNavigate(href) {
      void destroy({ reason: 'navigation' }).then((completed) => {
        if (!completed) return;
        if (typeof dependencies.navigate === 'function') {
          dependencies.navigate(href);
        } else {
          documentRef.location?.assign?.(href);
        }
      });
    }
  });

  render();
  renderTimer = timers.setInterval?.(
    renderAndHealWorkerCapacity,
    1000
  ) ?? null;
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
        releasePromise = Promise.resolve(destroyPage(options)).then(
          (completed) => {
            if (
              completed &&
              PAGE_INSTANCES.get(documentRef) === bootPromise
            ) {
              PAGE_INSTANCES.delete(documentRef);
            }
            if (!completed) releasePromise = null;
            return completed;
          },
          (error) => {
            releasePromise = null;
            throw error;
          }
        );
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
