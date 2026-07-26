import {
  COMMENT_CSV_HEADER,
  CSV_ROWS_PER_PART,
  buildCommentCsvRow,
  buildCsvPartName
} from './lib/comment-history-csv.mjs';
import { createCloudHistoryDataSource } from './lib/cloud-history-data-source.mjs';
import { createCloudHistoryController } from './lib/cloud-history-controller.mjs';
import { bootAppShell } from './lib/app-shell.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_DAYS = 90;

function validLocalDateParts(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, monthIndex, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== monthIndex
    || date.getDate() !== day
  ) {
    return null;
  }
  return { year, monthIndex, day };
}

export function localDayStart(value) {
  const parts = validLocalDateParts(value);
  return parts
    ? new Date(parts.year, parts.monthIndex, parts.day).getTime()
    : undefined;
}

export function localDayEnd(value) {
  const parts = validLocalDateParts(value);
  return parts
    ? new Date(parts.year, parts.monthIndex, parts.day + 1).getTime() - 1
    : undefined;
}

function normalizedText(value, { lowercase = false } = {}) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return lowercase ? normalized.toLowerCase() : normalized;
}

function normalizedPageSize(value) {
  return Number(value) === 100 ? 100 : 50;
}

export function buildHistoryFilter(values = {}) {
  const from = localDayStart(values.dateFrom);
  const to = localDayEnd(values.dateTo);
  const filter = {
    from,
    to,
    targetDomain: normalizedText(values.targetDomain, { lowercase: true }),
    promotedDomain: normalizedText(values.promotedDomain, { lowercase: true }),
    anchorTextPrefix: normalizedText(values.anchorTextPrefix, { lowercase: true }),
    hrefDomain: normalizedText(values.hrefDomain, { lowercase: true }),
    limit: normalizedPageSize(values.pageSize ?? values.limit)
  };
  return Object.fromEntries(
    Object.entries(filter).filter(([, value]) => value !== undefined)
  );
}

export function buildNotificationHistoryFilter(search, now = Date.now()) {
  if (typeof search !== 'string') return {};
  const filter = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    .get('filter');
  return filter === 'expired'
    ? { to: now - EXPIRY_DAYS * DAY_MS }
    : {};
}

function normalizedCursor(cursor) {
  if (!cursor || typeof cursor !== 'object') return null;
  if (
    Number.isFinite(cursor.submittedAt)
    && typeof cursor.id === 'string'
  ) {
    return { submittedAt: cursor.submittedAt, id: cursor.id };
  }
  if (
    typeof cursor.anchorKey === 'string'
    && typeof cursor.anchorPrimaryKey === 'string'
  ) {
    return {
      anchorKey: cursor.anchorKey,
      anchorPrimaryKey: cursor.anchorPrimaryKey
    };
  }
  return null;
}

export function buildHistoryListRequest(values = {}, cursor = null, extraFilter = {}) {
  const safeCursor = normalizedCursor(cursor);
  return {
    type: 'HISTORY_LIST',
    ...buildHistoryFilter(values),
    ...extraFilter,
    ...(safeCursor ? { cursor: safeCursor } : {})
  };
}

function buildActiveHistoryListRequest(activeFilter, cursor = null) {
  const safeCursor = normalizedCursor(cursor);
  return {
    type: 'HISTORY_LIST',
    ...activeFilter,
    ...(safeCursor ? { cursor: safeCursor } : {})
  };
}

export function buildAnchorsRequest(commentId) {
  return {
    type: 'HISTORY_ANCHORS',
    commentId: typeof commentId === 'string' ? commentId : ''
  };
}

export function buildConfirmedDeleteRequest(exportSessionId) {
  return {
    type: 'HISTORY_DELETE_CONFIRMED',
    confirmed: true,
    exportSessionId: normalizedText(exportSessionId) || ''
  };
}

export function createPaginationState() {
  return { cursors: [null], pageIndex: 0, cursor: null };
}

export function advancePagination(state, nextCursor) {
  const safeCursor = (
    nextCursor
    && typeof nextCursor === 'object'
    && ['local', 'cloud'].includes(nextCursor.phase)
    && Number.isFinite(nextCursor.cutoff)
  ) ? nextCursor : normalizedCursor(nextCursor);
  if (!safeCursor) return state;
  const pageIndex = state.pageIndex + 1;
  const cursors = state.cursors.slice(0, pageIndex);
  cursors.push(safeCursor);
  return { cursors, pageIndex, cursor: safeCursor };
}

export function retreatPagination(state) {
  if (!state || state.pageIndex <= 0) return state;
  const pageIndex = state.pageIndex - 1;
  return {
    cursors: state.cursors,
    pageIndex,
    cursor: state.cursors[pageIndex]
  };
}

export function setStoredText(element, value) {
  element.textContent = value == null ? '' : String(value);
  return element;
}

export function downloadCsvPart(documentRef, parts, filename, {
  BlobCtor = Blob,
  urlApi = URL
} = {}) {
  const blob = new BlobCtor(parts, { type: 'text/csv;charset=utf-8' });
  const objectUrl = urlApi.createObjectURL(blob);
  try {
    const link = documentRef.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    link.hidden = true;
    documentRef.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    urlApi.revokeObjectURL(objectUrl);
  }
}

function sendHistoryMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || '无法连接评论历史服务。'));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error?.message || '评论历史请求失败。'));
        return;
      }
      resolve(response.data);
    });
  });
}

function formatDateTime(timestamp) {
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function formatSnapshotRange(snapshotRange, exportedBefore) {
  const rangeStart = Number.isFinite(snapshotRange?.from)
    ? formatDateTime(snapshotRange.from)
    : '最早记录';
  const rangeEnd = Number.isFinite(snapshotRange?.to)
    ? formatDateTime(snapshotRange.to)
    : formatDateTime(exportedBefore);
  return `${rangeStart} 至 ${rangeEnd}`;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '不可用';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch (_) {
    return '';
  }
}

function createTextCell(documentRef, value, className = '') {
  const cell = documentRef.createElement('td');
  if (className) cell.className = className;
  return setStoredText(cell, value);
}

function createUrlCell(documentRef, value) {
  const cell = documentRef.createElement('td');
  cell.className = 'url-cell';
  const safeUrl = safeHttpUrl(value);
  if (!safeUrl) return setStoredText(cell, value || '—');
  const link = documentRef.createElement('a');
  link.href = safeUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  setStoredText(link, value);
  cell.appendChild(link);
  return cell;
}

function formValues(elements) {
  return {
    dateFrom: elements.dateFrom.value,
    dateTo: elements.dateTo.value,
    targetDomain: elements.targetDomain.value,
    promotedDomain: elements.promotedDomain.value,
    anchorTextPrefix: elements.anchorTextPrefix.value,
    hrefDomain: elements.hrefDomain.value,
    pageSize: elements.pageSize.value
  };
}

function setPageStatus(elements, message, isError = false) {
  setStoredText(elements.pageStatus, message);
  elements.pageStatus.classList.toggle('error', isError);
}

function renderSummary(elements, summary, estimatedUsage, cloudEnabled = false) {
  setStoredText(elements.summaryTotal, summary?.totalCount ?? 0);
  setStoredText(elements.summaryLast24Hours, summary?.last24HoursCount ?? 0);
  setStoredText(elements.summaryDueSoon, summary?.dueSoonCount ?? 0);
  setStoredText(elements.summaryExpired, summary?.expiredCount ?? 0);
  setStoredText(elements.summaryStorage, formatBytes(estimatedUsage));

  const dueSoonCount = Number(summary?.dueSoonCount) || 0;
  const expiredCount = Number(summary?.expiredCount) || 0;
  elements.retentionBanner.hidden = dueSoonCount === 0 && expiredCount === 0;
  if (expiredCount > 0) {
    setStoredText(
      elements.retentionBanner,
      cloudEnabled
        ? `有 ${expiredCount} 条记录已满 90 天；其中已确认同步且无待处理更改的本机缓存会自动清理，其他记录继续保留。`
        : `有 ${expiredCount} 条记录已满 90 天，仍会保留，直到你完成导出并明确确认删除。`
    );
  } else if (dueSoonCount > 0) {
    setStoredText(
      elements.retentionBanner,
      cloudEnabled
        ? `有 ${dueSoonCount} 条本机缓存将在近期达到 90 天；仅已确认同步且无待处理更改的记录会自动清理。`
        : `有 ${dueSoonCount} 条记录将在近期达到 90 天，请提前安排导出归档。`
    );
  }
}

async function loadAnchorDetails(documentRef, detailContainer, record) {
  detailContainer.dataset.loaded = 'loading';
  setStoredText(detailContainer, '正在加载锚链接…');
  try {
    const anchors = await sendHistoryMessage(buildAnchorsRequest(record.id));
    detailContainer.textContent = '';

    const commentTitle = documentRef.createElement('strong');
    setStoredText(commentTitle, '完整评论 HTML（按文本显示）');
    detailContainer.appendChild(commentTitle);
    const comment = documentRef.createElement('pre');
    comment.className = 'stored-html';
    setStoredText(comment, record.commentHtml || record.commentText || '');
    detailContainer.appendChild(comment);

    const anchorTitle = documentRef.createElement('strong');
    setStoredText(anchorTitle, `锚链接（${Array.isArray(anchors) ? anchors.length : 0}）`);
    detailContainer.appendChild(anchorTitle);
    const anchorList = documentRef.createElement('div');
    anchorList.className = 'anchor-list';
    if (!Array.isArray(anchors) || anchors.length === 0) {
      setStoredText(anchorList, '无锚链接');
    } else {
      for (const anchor of anchors) {
        const item = documentRef.createElement('div');
        item.className = 'anchor-item';
        const destination = anchor.hrefResolved || anchor.hrefRaw || '无链接';
        setStoredText(item, `${anchor.anchorText || '（无锚文本）'} → ${destination}`);
        anchorList.appendChild(item);
      }
    }
    detailContainer.appendChild(anchorList);
    detailContainer.dataset.loaded = 'true';
  } catch (error) {
    setStoredText(detailContainer, error.message);
    detailContainer.dataset.loaded = 'error';
  }
}

function renderRecords(documentRef, elements, records) {
  elements.historyTableBody.textContent = '';
  if (!Array.isArray(records) || records.length === 0) {
    const row = documentRef.createElement('tr');
    const cell = createTextCell(documentRef, '没有符合条件的评论历史。', 'empty-cell');
    cell.colSpan = 6;
    row.appendChild(cell);
    elements.historyTableBody.appendChild(row);
    return;
  }

  for (const record of records) {
    const row = documentRef.createElement('tr');
    const expandCell = documentRef.createElement('td');
    const expandButton = documentRef.createElement('button');
    expandButton.type = 'button';
    expandButton.className = 'expand-button';
    expandButton.setAttribute('aria-expanded', 'false');
    setStoredText(expandButton, '展开');
    expandCell.appendChild(expandButton);
    row.appendChild(expandCell);
    row.appendChild(createTextCell(documentRef, formatDateTime(record.submittedAt), 'time-cell'));
    row.appendChild(createUrlCell(documentRef, record.targetPageUrl));
    row.appendChild(createUrlCell(documentRef, record.promotedWebsiteUrl));
    row.appendChild(createTextCell(documentRef, record.commentText || record.commentHtml, 'comment-cell'));
    row.appendChild(createTextCell(documentRef, record.source === 'legacy' ? '旧记录' : '当前记录'));

    const detailRow = documentRef.createElement('tr');
    detailRow.className = 'detail-row';
    detailRow.hidden = true;
    const detailCell = documentRef.createElement('td');
    detailCell.colSpan = 6;
    const detailContainer = documentRef.createElement('div');
    detailContainer.className = 'detail-content';
    detailCell.appendChild(detailContainer);
    detailRow.appendChild(detailCell);

    expandButton.addEventListener('click', () => {
      const expanded = expandButton.getAttribute('aria-expanded') === 'true';
      expandButton.setAttribute('aria-expanded', String(!expanded));
      setStoredText(expandButton, expanded ? '展开' : '收起');
      detailRow.hidden = expanded;
      if (!expanded && !detailContainer.dataset.loaded) {
        loadAnchorDetails(documentRef, detailContainer, record);
      }
    });

    elements.historyTableBody.append(row, detailRow);
  }
}

function renderArchiveEvents(documentRef, elements, events) {
  elements.archiveTableBody.textContent = '';
  if (!Array.isArray(events) || events.length === 0) {
    const row = documentRef.createElement('tr');
    const cell = createTextCell(documentRef, '暂无归档清理记录。', 'empty-cell');
    cell.colSpan = 5;
    row.appendChild(cell);
    elements.archiveTableBody.appendChild(row);
    return;
  }

  for (const event of events) {
    const row = documentRef.createElement('tr');
    row.appendChild(createTextCell(documentRef, formatDateTime(event.deletedAt)));
    row.appendChild(createTextCell(documentRef, formatDateTime(event.rangeStart)));
    row.appendChild(createTextCell(documentRef, formatDateTime(event.rangeEnd)));
    row.appendChild(createTextCell(documentRef, event.recordCount ?? 0));
    const filenames = event.fileNames ?? event.filenames;
    row.appendChild(createTextCell(
      documentRef,
      Array.isArray(filenames) ? filenames.join('、') : ''
    ));
    elements.archiveTableBody.appendChild(row);
  }
}

function getElements(documentRef) {
  const ids = [
    'historyFilterForm',
    'dateFrom',
    'dateTo',
    'targetDomain',
    'promotedDomain',
    'anchorTextPrefix',
    'hrefDomain',
    'pageSize',
    'resetFiltersBtn',
    'summaryTotal',
    'summaryLast24Hours',
    'summaryDueSoon',
    'summaryExpired',
    'summaryStorage',
    'retentionBanner',
    'historyPendingBanner',
    'historyTableBody',
    'previousPageBtn',
    'nextPageBtn',
    'pageLabel',
    'pageStatus',
    'archiveTableBody',
    'exportHistoryBtn',
    'confirmDeleteBtn',
    'exportStatus'
  ];
  return Object.fromEntries(ids.map((id) => [id, documentRef.getElementById(id)]));
}

async function estimateStorage() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return estimate?.usage;
  } catch (_) {
    return undefined;
  }
}

export function bootHistoryPage(documentRef = document, {
  requestMessage = sendHistoryMessage,
  dataSource: dataSourceOverride,
  isOnline = () => (
    typeof navigator === 'undefined' || navigator.onLine !== false
  ),
  confirmDelete = async (message) => (
    documentRef.defaultView?.confirm?.(message) === true
  ),
  search = typeof location !== 'undefined' ? location.search : '',
  now = Date.now(),
  estimateStorage: estimateStorageForPage = estimateStorage,
  rowsPerPart = CSV_ROWS_PER_PART,
  downloadPart: downloadPartOverride
} = {}) {
  const elements = getElements(documentRef);
  if (Object.values(elements).some((element) => !element)) return;

  const dataSource = dataSourceOverride ?? createCloudHistoryDataSource({
    sendMessage: async (message) => {
      try {
        return { ok: true, data: await requestMessage(message) };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: typeof error?.code === 'string'
              ? error.code
              : 'HISTORY_REQUEST_FAILED',
            message: error?.message || '评论历史请求失败。',
            retryable: error?.retryable !== false
          }
        };
      }
    },
    now: () => now
  });
  const historyController = createCloudHistoryController({
    document: documentRef,
    dataSource,
    confirmDelete,
    loadLocalAnchors: (commentId) => requestMessage(
      buildAnchorsRequest(commentId)
    )
  });
  let pagination = createPaginationState();
  let nextCursor = null;
  let requestGeneration = 0;
  let cloudSyncStatus = Object.freeze({ enabled: false, state: 'unavailable' });
  let completedExportSessionId = '';
  let exportInProgress = false;
  let exportFilterGeneration = 0;
  let activeFilter = Object.freeze({
    ...buildHistoryFilter(formValues(elements)),
    ...buildNotificationHistoryFilter(search, now)
  });

  function renderPendingQueue(pendingCount) {
    if (!Number.isInteger(pendingCount)) {
      elements.historyPendingBanner.hidden = false;
      setStoredText(
        elements.historyPendingBanner,
        '评论历史待保存数量暂时无法刷新，请稍后重试。'
      );
      return;
    }
    const count = Number.isInteger(pendingCount) && pendingCount > 0
      ? pendingCount
      : 0;
    elements.historyPendingBanner.hidden = count === 0;
    setStoredText(
      elements.historyPendingBanner,
      count > 0
        ? `仍有 ${count} 条评论历史等待后台重试保存。`
        : ''
    );
  }

  async function loadPage() {
    const generation = ++requestGeneration;
    const pageState = {
      filter: { ...activeFilter },
      cursor: pagination.cursor,
      pageIndex: pagination.pageIndex
    };
    elements.previousPageBtn.disabled = true;
    elements.nextPageBtn.disabled = true;
    setPageStatus(elements, '正在加载…');
    try {
      const page = await dataSource.list({
        ...pageState.filter,
        syncEnabled: cloudSyncStatus.enabled === true,
        online: isOnline()
      }, pageState.cursor);
      if (generation !== requestGeneration) return;
      nextCursor = page?.nextCursor && typeof page.nextCursor === 'object'
        ? page.nextCursor
        : null;
      historyController.renderRecords(page?.records);
      setStoredText(elements.pageLabel, `第 ${pageState.pageIndex + 1} 页`);
      setPageStatus(elements, `本页 ${page?.records?.length || 0} 条`);
      return true;
    } catch (error) {
      if (generation !== requestGeneration) return false;
      setPageStatus(
        elements,
        error?.message || '评论历史请求失败，请稍后重试。',
        true
      );
      return false;
    } finally {
      if (generation !== requestGeneration) return;
      elements.previousPageBtn.disabled = pageState.pageIndex === 0;
      elements.nextPageBtn.disabled = !nextCursor;
    }
  }

  async function loadOverview() {
    const [summaryResult, archiveResult, estimatedUsage] = await Promise.allSettled([
      requestMessage({ type: 'HISTORY_SUMMARY' }),
      requestMessage({ type: 'HISTORY_ARCHIVE_EVENTS' }),
      estimateStorageForPage()
    ]);
    const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : {};
    renderSummary(
      elements,
      summary,
      estimatedUsage.status === 'fulfilled' ? estimatedUsage.value : undefined,
      cloudSyncStatus.enabled === true
    );
    renderArchiveEvents(
      documentRef,
      elements,
      archiveResult.status === 'fulfilled' ? archiveResult.value : []
    );
  }

  function setExportStatus(message, isError = false) {
    setStoredText(elements.exportStatus, message);
    elements.exportStatus.classList.toggle('error', isError);
  }

  function resetConfirmedDelete() {
    completedExportSessionId = '';
    elements.confirmDeleteBtn.disabled = true;
    elements.confirmDeleteBtn.hidden = true;
  }

  function invalidateConfirmedDelete() {
    exportFilterGeneration += 1;
    const hadEligibleExport = Boolean(completedExportSessionId);
    resetConfirmedDelete();
    if (hadEligibleExport) {
      setExportStatus('筛选条件已更改；如需清理，请按当前筛选重新导出。');
    }
  }

  async function exportActiveSnapshot() {
    if (exportInProgress) return;
    const filterGeneration = exportFilterGeneration;
    exportInProgress = true;
    elements.exportHistoryBtn.disabled = true;
    resetConfirmedDelete();
    setExportStatus('正在准备导出…');

    let csvParts = [COMMENT_CSV_HEADER];
    let currentPartRows = 0;
    let processedCount = 0;
    const filenames = [];
    try {
      const started = await requestMessage({
        type: 'HISTORY_EXPORT_START',
        ...activeFilter
      });
      const downloadPart = downloadPartOverride
        || ((parts, filename) => downloadCsvPart(documentRef, parts, filename));

      async function flushPart() {
        const filename = buildCsvPartName({
          from: started.criteria?.from,
          to: started.criteria?.to,
          exportedBefore: started.exportedBefore,
          part: filenames.length + 1
        });
        await downloadPart(csvParts, filename);
        filenames.push(filename);
        csvParts = [COMMENT_CSV_HEADER];
        currentPartRows = 0;
      }

      let cursor = null;
      do {
        const page = await requestMessage({
          type: 'HISTORY_EXPORT_CHUNK',
          exportSessionId: started.exportSessionId,
          ...(cursor ? { cursor } : {})
        });
        const bundles = Array.isArray(page?.records) ? page.records : [];
        for (const bundle of bundles) {
          csvParts.push(buildCommentCsvRow(bundle?.comment, bundle?.anchors));
          currentPartRows += 1;
          processedCount += 1;
          if (currentPartRows === rowsPerPart) await flushPart();
        }
        cursor = normalizedCursor(page?.nextCursor);
        setExportStatus(
          `正在导出：已处理 ${processedCount} / ${started.expectedCount} 条，已完成 ${filenames.length} 个文件`
        );
      } while (cursor);

      if (processedCount !== started.expectedCount) {
        throw new Error('导出记录集合已变化，请重新导出。');
      }
      if (currentPartRows > 0 || processedCount === 0) await flushPart();

      await requestMessage({
        type: 'HISTORY_EXPORT_FINISH',
        exportSessionId: started.exportSessionId,
        filenames
      });
      if (filterGeneration !== exportFilterGeneration) {
        resetConfirmedDelete();
        setExportStatus(
          '导出归档已完成，但筛选条件已更改；如需清理，请按当前筛选重新导出。'
        );
        return;
      }
      const snapshotRange = formatSnapshotRange(
        started.snapshotRange,
        started.exportedBefore
      );
      if (started.cleanupEligible === true) {
        completedExportSessionId = started.exportSessionId;
        elements.confirmDeleteBtn.hidden = false;
        elements.confirmDeleteBtn.disabled = false;
        setExportStatus(
          `导出完成：服务器快照 ${started.expectedCount} 条，范围 ${snapshotRange}，共 ${filenames.length} 个文件。`
        );
      } else {
        resetConfirmedDelete();
        setExportStatus(
          `仅归档：服务器快照 ${started.expectedCount} 条，范围 ${snapshotRange}，共 ${filenames.length} 个文件；快照包含未满 90 天的记录，不提供删除确认。`
        );
      }
    } catch (error) {
      csvParts = [];
      resetConfirmedDelete();
      setExportStatus(error.message || '导出失败，请重试。', true);
    } finally {
      exportInProgress = false;
      elements.exportHistoryBtn.disabled = false;
    }
  }

  async function deleteCompletedExport() {
    if (!completedExportSessionId) return;
    elements.confirmDeleteBtn.disabled = true;
    elements.exportHistoryBtn.disabled = true;
    setExportStatus('正在核对并删除已归档记录…');
    let result;
    try {
      result = await requestMessage(
        buildConfirmedDeleteRequest(completedExportSessionId)
      );
    } catch (error) {
      elements.confirmDeleteBtn.disabled = false;
      setExportStatus(error.message || '删除失败，请重新导出后再试。', true);
      elements.exportHistoryBtn.disabled = false;
      return;
    }

    resetConfirmedDelete();
    const successMessage = `已删除 ${result?.deletedCount || 0} 条已归档记录。`;
    setExportStatus(successMessage);
    try {
      const [, pageLoaded] = await Promise.all([loadOverview(), loadPage()]);
      if (!pageLoaded) throw new Error('page refresh failed');
    } catch (_) {
      setExportStatus(`${successMessage} 页面数据刷新失败，请手动刷新。`, true);
    }
    elements.exportHistoryBtn.disabled = false;
  }

  function commitActiveFilter() {
    invalidateConfirmedDelete();
    activeFilter = Object.freeze(buildHistoryFilter(formValues(elements)));
    pagination = createPaginationState();
    nextCursor = null;
    return loadPage();
  }

  elements.historyFilterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    commitActiveFilter();
  });
  elements.historyFilterForm.addEventListener('input', invalidateConfirmedDelete);
  elements.historyFilterForm.addEventListener('change', invalidateConfirmedDelete);
  elements.resetFiltersBtn.addEventListener('click', () => {
    elements.historyFilterForm.reset();
    commitActiveFilter();
  });
  elements.pageSize.addEventListener('change', () => {
    commitActiveFilter();
  });
  elements.previousPageBtn.addEventListener('click', () => {
    pagination = retreatPagination(pagination);
    loadPage();
  });
  elements.nextPageBtn.addEventListener('click', () => {
    if (!nextCursor) return;
    pagination = advancePagination(pagination, nextCursor);
    loadPage();
  });
  elements.exportHistoryBtn.addEventListener('click', exportActiveSnapshot);
  elements.confirmDeleteBtn.addEventListener('click', deleteCompletedExport);

  elements.exportHistoryBtn.disabled = false;
  elements.confirmDeleteBtn.hidden = true;
  (async () => {
    try {
      const retryResult = await requestMessage({ type: 'HISTORY_RETRY_PENDING' });
      renderPendingQueue(retryResult?.pending);
    } catch (_) {
      // The page remains usable if the retry status cannot be refreshed.
    }
    try {
      cloudSyncStatus = Object.freeze(await dataSource.status());
    } catch (_) {
      cloudSyncStatus = Object.freeze({
        enabled: false,
        state: 'unavailable'
      });
    }
    historyController.renderStatus(cloudSyncStatus, isOnline());
    await Promise.all([loadOverview(), loadPage()]);
  })();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    bootAppShell(document, { currentUrl: window.location.href });
    bootHistoryPage(document);
  });
}
