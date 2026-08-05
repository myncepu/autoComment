import {
  getBatchError,
  getBatchRetryPolicy
} from './batch-error-policy.mjs';
import {
  hasPublishedEvidence,
  isUnexecutedResult
} from './batch-result-classification.mjs';

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function clampInteger(value, minimum, maximum, fallback) {
  if (!Number.isFinite(Number(value))) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(Number(value))));
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const RUNTIME_ERROR_PRESENTATION = Object.freeze({
  batch_ownership_active: {
    title: '当前批次仍在运行',
    message: '当前批次仍有活动任务，请继续处理或停止批次。'
  },
  batch_ownership_unverified: {
    title: '批次所有权需要确认',
    message: '无法安全验证旧 worker 标签页；批次已暂停。请检查标签页后继续处理或停止批次。'
  },
  stale_worker_tab: {
    title: '旧 worker 标签页已失效',
    message: '检测到已失效的 worker 标签页；请关闭旧标签页后继续处理当前批次。'
  },
  content_script_unavailable: {
    title: '目标页面脚本未能就绪',
    message: '已结束该目标并继续处理队列。请在目标行详情中查看权限、导航或脚本接收错误。'
  },
  batch_target_permission_denied: {
    title: '目标网站访问权限未授予',
    message: '未授予目标网站访问权限，批次尚未启动。请再次点击开始并允许访问这些网站。'
  },
  batch_target_permission_unavailable: {
    title: '目标网站权限服务不可用',
    message: 'Chrome 无法申请目标网站访问权限，请重新加载扩展后重试。'
  },
  checkpoint_write_failed: {
    title: '检查点保存失败',
    message: '检查点保存失败，批次已停止继续领任务。请重试保存后再继续。'
  },
  recovery_persistence_required: {
    title: '恢复状态尚未保存',
    message: '请先保存恢复检查点，再继续处理当前批次。'
  },
  recent_success_history_unavailable: {
    title: '近期成功记录暂不可用',
    message: '近期成功记录暂不可用，无法安全排除重复目标。请重试加载后再开始批次。'
  },
  outlink_success_history_unavailable: {
    title: '历史发布记录暂不可用',
    message: '历史发布记录暂不可用，无法安全排除同一推广网站的重复发布。请重试加载后再开始批次。'
  },
  target_promotion_success_history_changed: {
    title: '历史发布记录已更新',
    message: '确认计划后检测到该推广网站已在目标博客成功发布。请重新加载批次计划，系统会自动排除重复组合。'
  },
  domain_config_unavailable: {
    title: '批次配置暂不可用',
    message: '身份与推广网站配置暂不可用。请重试加载，避免使用过期配置开始批次。'
  },
  domain_config_changed: {
    title: '批次配置已更新',
    message: '身份或推广网站配置已发生变化，请重新打开向导并确认分配。'
  },
  stale_domain_config_revision: {
    title: '批次配置版本已失效',
    message: '当前向导使用的是旧配置，请重新加载身份和推广网站配置。'
  },
  worker_pause_rejected: {
    title: '暂停 worker 标签页失败',
    message: '未能安全暂停全部 worker 标签页，请重试暂停或停止批次。'
  },
  worker_pause_failed: {
    title: '暂停 worker 标签页失败',
    message: '暂停 worker 标签页时发生错误，请重试暂停或停止批次。'
  },
  worker_resume_rejected: {
    title: '恢复 worker 标签页失败',
    message: '恢复 worker 标签页失败，批次仍保持暂停。请重试继续处理。'
  },
  worker_resume_failed: {
    title: '恢复 worker 标签页失败',
    message: '恢复 worker 标签页时发生错误，批次仍保持暂停。'
  },
  worker_stop_rejected: {
    title: '停止 worker 标签页失败',
    message: '停止 worker 标签页失败，请重试停止批次。'
  },
  worker_stop_failed: {
    title: '停止 worker 标签页失败',
    message: '停止 worker 标签页时发生错误，请重试停止批次。'
  },
  worker_refill_rejected: {
    title: '补充 worker 标签页失败',
    message: '未能补充空闲 worker 标签页，批次已暂停，请重试继续处理。'
  },
  worker_refill_failed: {
    title: '补充 worker 标签页失败',
    message: '补充 worker 标签页时发生错误，批次已暂停。'
  },
  worker_tab_reconcile_failed: {
    title: 'worker 标签页状态同步失败',
    message: 'worker 标签页状态同步失败，请重试继续处理或停止批次。'
  },
  batch_confirmation_failed: {
    title: '任务确认状态同步失败',
    message: '任务确认状态未能同步，请保留页面并重试。'
  },
  batch_runtime_failed: {
    title: '批次运行服务暂不可用',
    message: '批次运行服务暂不可用，请重新加载扩展页面后重试。'
  },
  batch_offline: {
    title: '当前离线',
    message: '网络连接不可用，批次保持暂停；恢复在线后请手动继续。'
  },
  batch_command_in_progress: {
    title: '已有操作正在执行',
    message: '请等待当前操作完成后再执行下一项操作。'
  },
  batch_teardown_failed: {
    title: '页面退出保护未完成',
    message: '未能完成页面退出保护，请保留当前页面并重试。'
  },
  batch_teardown_cleanup_failed: {
    title: 'worker 清理未完成',
    message: '部分 worker 标签页尚未清理，请重试停止批次。'
  },
  batch_boot_failed: {
    title: '批次控制台暂时无法启动',
    message: '批次控制台加载失败，请重新加载扩展页面后重试。'
  },
  batch_page_owned_elsewhere: {
    title: '批次正在另一页面运行',
    message: '另一个批次页仍在管理当前任务，请返回该页面，或关闭旧页面后重新加载。'
  },
  csv_parse_failed: {
    title: 'CSV 解析失败',
    message: '无法读取 CSV，请确认文件编码、表头和格式后重试。'
  },
  invalid_csv_bytes: {
    title: 'CSV 文件无效',
    message: 'CSV 文件内容无效，请重新选择文件。'
  },
  invalid_csv_input: {
    title: 'CSV 文件无效',
    message: 'CSV 文件内容无效，请重新选择文件。'
  },
  csv_header_required: {
    title: 'CSV 缺少表头',
    message: 'CSV 必须包含表头，请补充后重新导入。'
  },
  invalid_column_mapping: {
    title: 'CSV 列映射无效',
    message: '列映射无效，请重新选择目标 URL、身份和推广网站列。'
  },
  duplicate_column_mapping: {
    title: 'CSV 列映射重复',
    message: '同一列不能分配给多个字段，请重新选择列映射。'
  },
  target_url_column_required: {
    title: '缺少目标 URL 列',
    message: '请选择包含目标 URL 的 CSV 列。'
  },
  assignment_columns_must_both_be_mapped: {
    title: '批次分配列不完整',
    message: '身份列和推广网站列需要同时映射，或同时留空。'
  },
  assignment_pair_not_approved: {
    title: '批次分配不可用',
    message: '部分目标使用了未批准的身份与推广网站组合，请修改后重试。'
  },
  promotion_site_not_found: {
    title: '推广网站不存在',
    message: 'CSV 引用的推广网站不存在，请检查配置或列内容。'
  },
  promotion_site_disabled: {
    title: '推广网站已停用',
    message: 'CSV 引用的推广网站已停用，请更换后重试。'
  },
  saved_batch_plan_invalid: {
    title: '上次批次计划已失效',
    message: '上次保存的批次计划无法恢复，请重新导入 CSV。'
  },
  invalid_batch_plan: {
    title: '批次计划无效',
    message: '批次计划无效，请重新导入 CSV 并确认分配。'
  },
  plan_confirmation_failed: {
    title: '批次确认失败',
    message: '无法确认当前批次计划，请返回检查后重试。'
  }
});

const COMMAND_RESULT_MESSAGES = Object.freeze({
  start: '批次已开始',
  pause: '批次已暂停',
  resume: '批次已继续',
  stop: '批次已停止',
  retry: '任务已重新排队',
  'retry-persistence': '恢复检查点已保存',
  offline: '批次已因离线暂停',
  manual: '人工处理状态已更新'
});

export function runtimeErrorMessage(errorCode) {
  const code = text(errorCode);
  return RUNTIME_ERROR_PRESENTATION[code]?.message ||
    '批次操作未完成，请重试；如持续出现，请重新加载扩展。';
}

export function batchCommandMessage(command) {
  return COMMAND_RESULT_MESSAGES[text(command)] || '操作已完成';
}

function elapsedFromResult(result) {
  return Number.isFinite(result?.elapsed)
    ? Math.max(0, Math.round(result.elapsed * 1000))
    : null;
}

function elapsedForTask(task, result, now) {
  if (result) return elapsedFromResult(result);
  if (['active', 'submitting'].includes(task?.state) &&
    Number.isFinite(task.startedAt)) {
    return Math.max(0, now - task.startedAt);
  }
  return null;
}

function errorForResult(result) {
  if (!result?.errorCode) return null;
  return getBatchError(result.errorCode);
}

function resultForAttempt(resultsByTask, urlIndex, attempt) {
  return resultsByTask.get(`${urlIndex}:${attempt}`) || null;
}

function attemptHistory(results, currentAttempt) {
  return results
    .filter((result) => result.attempt < currentAttempt)
    .sort((left, right) => left.attempt - right.attempt)
    .map((result) => ({
      attempt: result.attempt,
      result: result.result,
      error: errorForResult(result),
      timestamp: finiteOrNull(result.timestamp),
      elapsedMs: elapsedFromResult(result)
    }));
}

function rowStatus(task, result) {
  if (task.state === 'queued') return 'queued';
  if (task.state === 'active' || task.state === 'submitting') return 'running';
  if (task.manualResolution?.status !== 'idle' ||
    ['manual_required', 'no_comment_box'].includes(result?.result)) {
    return 'manual';
  }
  if (hasPublishedEvidence(result)) return 'success';
  if (isUnexecutedResult(result)) return 'skipped';
  return 'failed';
}

function actionsForRow(task, retryPolicy) {
  const actions = ['details'];
  if (['active', 'submitting'].includes(task.state) &&
    Number.isInteger(task.tabId)) {
    actions.push('focus-tab');
  }
  if (task.state === 'terminal' && retryPolicy !== 'blocked') {
    actions.push('retry');
  }
  return actions;
}

function timestampForRow(task, result) {
  return finiteOrNull(result?.timestamp) ?? finiteOrNull(task.updatedAt);
}

function makeRow({
  batchId,
  item,
  task,
  results,
  resultsByTask,
  profiles,
  promotionSites,
  now
}) {
  const currentResult = resultForAttempt(resultsByTask, task.urlIndex, task.attempt);
  const retryPolicy = getBatchRetryPolicy(currentResult || {});
  const profileId = text(task.profileId || currentResult?.profileId);
  const promotionSiteId = text(
    task.promotionSiteId || currentResult?.promotionSiteId
  );
  return {
    taskId: `${batchId}:${task.urlIndex}:${task.attempt}`,
    urlIndex: task.urlIndex,
    attempt: task.attempt,
    url: String(item?.url || ''),
    domain: String(item?.sourceDomain || ''),
    profileId,
    profileLabel: text(
      profiles?.[profileId]?.displayName || currentResult?.profileDisplayName
    ) || profileId || '未分配',
    promotionSiteId,
    promotionSiteLabel: text(
      promotionSites?.[promotionSiteId]?.name || currentResult?.promotionSiteName
    ) || promotionSiteId || '未分配',
    assignmentPairId: text(
      task.assignmentPairId || currentResult?.assignmentPairId
    ),
    assignmentSource: text(
      task.assignmentSource || currentResult?.assignmentSource
    ),
    state: task.state,
    phase: task.phase || null,
    elapsedMs: elapsedForTask(task, currentResult, now),
    result: currentResult?.result || null,
    skipReason: text(currentResult?.skipReason) || null,
    error: errorForResult(currentResult),
    errorMessage: typeof currentResult?.errorMessage === 'string'
      ? currentResult.errorMessage
      : null,
    retryPolicy,
    actions: actionsForRow(task, retryPolicy),
    manualResolution: {
      status: task.manualResolution?.status || 'idle',
      updatedAt: finiteOrNull(task.manualResolution?.updatedAt)
    },
    attemptHistory: attemptHistory(results, task.attempt),
    aiContent: currentResult?.aiContent || null,
    commentText: text(
      currentResult?.commentText || currentResult?.aiContent
    ) || null,
    anchorTexts: Array.isArray(currentResult?.anchorTexts)
      ? currentResult.anchorTexts.map(text).filter(Boolean)
      : [],
    promotedWebsiteUrl: text(
      currentResult?.promotedWebsiteUrl ||
      currentResult?.promotionSiteUrl ||
      promotionSites?.[promotionSiteId]?.url
    ) || null,
    submittedAt: currentResult?.result === 'success'
      ? finiteOrNull(currentResult.submittedAt) ??
        finiteOrNull(currentResult.timestamp)
      : null,
    timestamp: timestampForRow(task, currentResult),
    status: rowStatus(task, currentResult)
  };
}

function assignmentFor(checkpoint, options, concurrency, timeoutSeconds) {
  if (checkpoint?.version === 3) {
    const profileCount = Object.keys(checkpoint.profiles || {}).length;
    const siteCount = Object.keys(checkpoint.promotionSites || {}).length;
    const autoSubmit = checkpoint.settings?.autoSubmit === true;
    const autoGenerate = autoSubmit || checkpoint.settings?.autoGenerate === true;
    return {
      identityLabel: `${profileCount} 个身份`,
      promotionSiteLabel: `${siteCount} 个推广网站`,
      automationLabel: autoSubmit
        ? '生成并自动提交'
        : autoGenerate
          ? '仅自动生成'
          : '人工处理',
      limitsLabel: `并发 ${concurrency} · 超时 ${timeoutSeconds}s`
    };
  }
  const settings = checkpoint?.settings || {};
  const source = options.assignment || settings.assignment || {};
  const identityId = text(source.identityId);
  const identityName = text(source.identitySnapshot?.displayName);
  const promotionId = text(source.promotionSiteId);
  const promotionLabel = text(source.promotionSiteSnapshot?.label);
  let identityLabel = text(source.identityLabel);
  if (!identityLabel && identityName) {
    identityLabel = identityId === 'default-identity'
      ? `默认身份 · ${identityName}`
      : identityName;
  }
  identityLabel ||= identityId || '未分配';

  const autoSubmit = settings.autoSubmit === true;
  const autoGenerate = autoSubmit || settings.autoGenerate === true;
  const automationLabel = text(source.automationLabel) || (
    autoSubmit
      ? '生成并自动提交'
      : autoGenerate
        ? '仅自动生成'
        : '人工处理'
  );
  return {
    identityLabel,
    promotionSiteLabel: text(source.promotionSiteLabel) ||
      promotionLabel ||
      promotionId ||
      '未分配',
    automationLabel,
    limitsLabel: text(source.limitsLabel) ||
      `并发 ${concurrency} · 超时 ${timeoutSeconds}s`
  };
}

function commandFor({
  status,
  batchId,
  rowCount,
  tasks,
  online,
  persistencePending,
  inFlight,
  hasLegacyResults,
  openingReservations,
  resultMessage
}) {
  const busy = Boolean(inFlight);
  const hasBatch = Boolean(batchId);
  const isRunning = status === 'running';
  const isPaused = status === 'paused_recovery';
  const hasDurableActiveTasks = Object.values(tasks || {}).some((task) => (
    ['active', 'submitting'].includes(task?.state)
  ));
  const hasDurableOpeningReservations =
    Object.keys(openingReservations || {}).length > 0;
  return {
    inFlight,
    canPause: !busy && isRunning && online,
    canResume: !busy && isPaused && online && !persistencePending,
    canStop: !busy && hasBatch &&
      (isRunning || isPaused),
    canExport: !busy && (
      (hasBatch && rowCount > 0) ||
      (!hasBatch && hasLegacyResults)
    ),
    canRetryPersistence: !busy && online && persistencePending && hasBatch,
    canCreate: !busy && online && !persistencePending && (
      !hasBatch ||
      (
        !isRunning &&
        !hasDurableActiveTasks &&
        !hasDurableOpeningReservations
      )
    ),
    resultMessage
  };
}

function bannersFor(checkpoint, options, {
  online,
  persistencePending,
  status
}) {
  if (Array.isArray(options.banners)) {
    return options.banners.map((banner) => ({
      kind: text(banner?.kind) || 'notice',
      title: text(banner?.title),
      message: text(banner?.message)
    }));
  }
  const banners = [];
  if (!online) {
    banners.push({
      kind: 'offline',
      title: '当前离线',
      message: '批次已安全暂停；恢复在线后仍需手动继续。'
    });
  }
  if (persistencePending) {
    banners.push({
      kind: 'persistence',
      title: '恢复检查点尚未持久化',
      message: '继续处理已锁定，请保留当前页面并重试保存。'
    });
  } else if (status === 'paused_recovery' && online) {
    banners.push({
      kind: 'recovery',
      title: '已从检查点安全恢复',
      message: '任务不会自动继续；请检查后手动恢复。'
    });
  }
  const runtimeError = options.runtimeError;
  if (runtimeError) {
    const errorCode = text(runtimeError.errorCode || runtimeError);
    const presentation = RUNTIME_ERROR_PRESENTATION[errorCode];
    banners.push({
      kind: 'error',
      title: presentation?.title || '运行时发生错误',
      message: runtimeErrorMessage(errorCode),
      diagnosticCode: errorCode || null
    });
  }
  for (const banner of options.extraBanners || []) {
    banners.push({
      kind: text(banner?.kind) || 'notice',
      title: text(banner?.title),
      message: text(banner?.message)
    });
  }
  return banners;
}

export function createBatchConsoleSnapshot(checkpoint, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const status = checkpoint?.batchId
    ? checkpoint?.status || 'paused_recovery'
    : 'empty';
  const batchId = String(checkpoint?.batchId || '');
  const online = options.online !== false;
  const persistencePending = checkpoint?.persistencePending === true ||
    options.persistencePending === true;
  const concurrency = clampInteger(
    checkpoint?.settings?.concurrency,
    1,
    10,
    3
  );
  const timeoutSeconds = clampInteger(
    checkpoint?.settings?.timeoutSeconds,
    10,
    600,
    60
  );
  const parsedUrls = Array.isArray(checkpoint?.source?.parsedUrls)
    ? checkpoint.source.parsedUrls
    : [];
  const tasks = checkpoint?.tasks && typeof checkpoint.tasks === 'object'
    ? checkpoint.tasks
    : {};
  const results = Array.isArray(checkpoint?.results) ? checkpoint.results : [];
  const resultsByTask = new Map();
  const resultsByUrlIndex = new Map();

  for (const result of results) {
    if (!Number.isInteger(result?.originalIndex) ||
      !Number.isInteger(result?.attempt)) continue;
    resultsByTask.set(`${result.originalIndex}:${result.attempt}`, result);
    const prior = resultsByUrlIndex.get(result.originalIndex) || [];
    prior.push(result);
    resultsByUrlIndex.set(result.originalIndex, prior);
  }

  const rows = parsedUrls.map((item, urlIndex) => {
    const task = tasks[String(urlIndex)] || {
      urlIndex,
      attempt: 1,
      state: 'queued',
      phase: null,
      windowId: null,
      startedAt: null,
      updatedAt: null,
      manualResolution: { status: 'idle', updatedAt: null }
    };
    return makeRow({
      batchId: String(checkpoint?.batchId || ''),
      item,
      task,
      results: resultsByUrlIndex.get(urlIndex) || [],
      resultsByTask,
      profiles: checkpoint?.profiles,
      promotionSites: checkpoint?.promotionSites,
      now
    });
  });

  const counts = {
    total: rows.length,
    queued: 0,
    running: 0,
    success: 0,
    skipped: 0,
    failed: 0,
    manual: 0
  };
  for (const row of rows) counts[row.status] += 1;

  const filters = {
    status: text(options.filters?.status) || 'all',
    domain: text(options.filters?.domain) || 'all',
    profile: text(options.filters?.profile) || 'all',
    promotionSite: text(options.filters?.promotionSite) || 'all',
    timeRange: options.filters?.timeRange || 'all',
    keyword: String(options.filters?.keyword || '')
  };
  const lastCheckpointSavedAt = finiteOrNull(options.lastCheckpointSavedAt) ??
    finiteOrNull(checkpoint?.updatedAt);
  const keepAlive = typeof options.keepAlive === 'boolean'
    ? options.keepAlive
    : status === 'running' && online && !persistencePending;
  const checkpointState = persistencePending
    ? 'pending'
    : text(options.checkpointState) || 'saved';
  const inFlight = text(options.inFlight || options.command?.inFlight) || null;
  const resultMessage = text(
    options.command?.resultMessage || options.commandResult
  );
  const assignment = assignmentFor(
    checkpoint,
    options,
    concurrency,
    timeoutSeconds
  );
  const banners = bannersFor(checkpoint, options, {
    online,
    persistencePending,
    status
  });
  const command = commandFor({
    status,
    batchId,
    rowCount: rows.length,
    tasks,
    online,
    persistencePending,
    inFlight,
    hasLegacyResults: options.hasLegacyResults === true,
    openingReservations: checkpoint?.openingReservations,
    resultMessage
  });

  return {
    batchId,
    status,
    batchName: text(options.batchName) ||
      text(checkpoint?.batchName) ||
      text(checkpoint?.source?.fileName) ||
      batchId,
    now,
    online,
    lastCheckpointSavedAt,
    checkpointState,
    persistencePending,
    keepAlive,
    health: {
      online,
      lastCheckpointSavedAt,
      checkpointState,
      persistencePending,
      keepAlive
    },
    concurrency,
    slotCapacity: concurrency,
    assignment,
    counts,
    slots: rows.filter((row) => row.status === 'running').map((row) => ({
      taskId: row.taskId,
      urlIndex: row.urlIndex,
      attempt: row.attempt,
      url: row.url,
      domain: row.domain,
      profileId: row.profileId,
      profileLabel: row.profileLabel,
      promotionSiteId: row.promotionSiteId,
      promotionSiteLabel: row.promotionSiteLabel,
      phase: row.phase,
      tabId: Number.isInteger(tasks[String(row.urlIndex)]?.tabId)
        ? tasks[String(row.urlIndex)].tabId
        : null,
      tabLabel: Number.isInteger(tasks[String(row.urlIndex)]?.tabId)
        ? `标签页 ${tasks[String(row.urlIndex)].tabId}`
        : 'worker 标签页',
      elapsedMs: row.elapsedMs
    })),
    rows,
    filteredRows: filterBatchTaskRows(rows, filters),
    filters,
    banners,
    command
  };
}

function matchesTimeRange(row, timeRange, latestTimestamp) {
  if (!timeRange || timeRange === 'all') return true;
  const timestamp = row.timestamp;
  if (!Number.isFinite(timestamp)) return false;
  if (typeof timeRange === 'object') {
    const from = finiteOrNull(timeRange.from) ?? -Infinity;
    const to = finiteOrNull(timeRange.to) ?? Infinity;
    return timestamp >= from && timestamp <= to;
  }
  const duration = {
    'last-hour': 60 * 60 * 1000,
    'last-day': 24 * 60 * 60 * 1000,
    'last-week': 7 * 24 * 60 * 60 * 1000
  }[timeRange];
  return Number.isFinite(duration) && timestamp >= latestTimestamp - duration;
}

export function filterBatchTaskRows(rows, filters = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const status = filters.status || 'all';
  const domain = filters.domain || 'all';
  const profile = filters.profile || 'all';
  const promotionSite = filters.promotionSite || 'all';
  const timeRange = filters.timeRange || 'all';
  const keyword = String(filters.keyword || '').trim().toLocaleLowerCase();
  const latestTimestamp = sourceRows.reduce((latest, row) => Math.max(
    latest,
    finiteOrNull(row?.timestamp) ?? -Infinity
  ), -Infinity);

  return sourceRows.filter((row) => {
    if (status !== 'all' && row.status !== status) return false;
    if (domain !== 'all' && row.domain !== domain) return false;
    if (profile !== 'all' && row.profileId !== profile) return false;
    if (promotionSite !== 'all' && row.promotionSiteId !== promotionSite) return false;
    if (!matchesTimeRange(row, timeRange, latestTimestamp)) return false;
    if (!keyword) return true;
    const searchable = [
      row.url,
      row.profileLabel,
      row.promotionSiteLabel,
      row.error?.message,
      row.errorMessage,
      row.aiContent,
      row.commentText,
      ...(Array.isArray(row.anchorTexts) ? row.anchorTexts : []),
      row.promotedWebsiteUrl,
      ...row.attemptHistory.map((attempt) => attempt.error?.message)
    ].filter(Boolean).join('\n').toLocaleLowerCase();
    return searchable.includes(keyword);
  });
}
