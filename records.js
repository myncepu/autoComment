import { bootAppShell } from './lib/app-shell.mjs';

const PAGE_SIZE = 50;
let pageIndex = 0;
let activeFilter = {};
let currentRecords = [];
const selectedIds = new Set();

function element(id) {
  return document.getElementById(id);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error?.message || '外链数据请求失败'));
        return;
      }
      resolve(response.data);
    });
  });
}

function formatDateTime(value) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch (_) {
    return '';
  }
}

function createUrlCell(value, secondary) {
  const cell = document.createElement('td');
  cell.className = 'url-cell';
  const url = safeHttpUrl(value);
  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = value;
    cell.appendChild(link);
  } else {
    cell.textContent = value || '—';
  }
  if (secondary) {
    const detail = document.createElement('span');
    detail.className = 'url-secondary';
    detail.textContent = secondary;
    cell.appendChild(detail);
  }
  return cell;
}

function renderRows(records) {
  const body = element('outlinkTableBody');
  body.replaceChildren();
  currentRecords = records;
  if (!records.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.className = 'empty-row';
    cell.textContent = '暂无符合条件的外链记录';
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  for (const record of records) {
    const row = document.createElement('tr');
    const selectCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedIds.has(record.id);
    checkbox.setAttribute('aria-label', `选择 ${record.url}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedIds.add(record.id);
      else selectedIds.delete(record.id);
      updateSelectionControls();
    });
    selectCell.appendChild(checkbox);
    row.appendChild(selectCell);

    const timeCell = document.createElement('td');
    timeCell.textContent = formatDateTime(record.lastCapturedAt);
    row.appendChild(timeCell);
    row.appendChild(createUrlCell(record.sourceUrl, record.sourceTitle || record.sourceHost));
    row.appendChild(createUrlCell(record.url, record.host));

    const typeCell = document.createElement('td');
    const type = document.createElement('span');
    type.className = `link-type${record.isNofollow ? ' nofollow' : ''}`;
    type.textContent = record.isNofollow ? 'NoFollow' : 'DoFollow';
    typeCell.appendChild(type);
    row.appendChild(typeCell);

    const textCell = document.createElement('td');
    textCell.textContent = record.text || '—';
    row.appendChild(textCell);

    const countCell = document.createElement('td');
    countCell.textContent = String(record.captureCount || 1);
    row.appendChild(countCell);
    body.appendChild(row);
  }
}

function updateSelectionControls() {
  element('deleteSelectedBtn').disabled = selectedIds.size === 0;
  element('selectPage').checked = Boolean(
    currentRecords.length
    && currentRecords.every((record) => selectedIds.has(record.id))
  );
}

function readFilter() {
  return {
    sourceHost: element('sourceHost').value.trim(),
    targetHost: element('targetHost').value.trim(),
    keyword: element('keyword').value.trim(),
    linkType: element('linkType').value
  };
}

async function loadSummary() {
  const summary = await sendMessage({ type: 'OUTLINKS_SUMMARY' });
  element('summaryTotal').textContent = String(summary.total);
  element('summarySources').textContent = String(summary.sourceHosts);
  element('summaryTargets').textContent = String(summary.targetHosts);
  element('summaryLastExport').textContent = formatDateTime(summary.lastCapturedAt);
}

async function loadPage() {
  element('tableStatus').textContent = '正在读取…';
  try {
    const data = await sendMessage({
      type: 'OUTLINKS_LIST',
      filter: activeFilter,
      offset: pageIndex * PAGE_SIZE,
      limit: PAGE_SIZE
    });
    renderRows(data.records);
    const pageCount = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
    element('pageStatus').textContent = `${data.total} 条记录`;
    element('pageLabel').textContent = `第 ${pageIndex + 1} / ${pageCount} 页`;
    element('previousPageBtn').disabled = pageIndex === 0;
    element('nextPageBtn').disabled = pageIndex + 1 >= pageCount;
    element('tableStatus').textContent = '';
    updateSelectionControls();
  } catch (error) {
    element('tableStatus').textContent = error.message;
    renderRows([]);
  }
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/gu, '""')}"`;
}

function downloadCsv(records) {
  const rows = [
    ['来源页面', '来源域名', '外链 URL', '外链域名', '类型', '锚文本', '首次导出', '最近导出', '导出次数'],
    ...records.map((record) => [
      record.sourceUrl,
      record.sourceHost,
      record.url,
      record.host,
      record.isNofollow ? 'NoFollow' : 'DoFollow',
      record.text,
      formatDateTime(record.firstCapturedAt),
      formatDateTime(record.lastCapturedAt),
      record.captureCount || 1
    ])
  ].map((row) => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([`\uFEFF${rows}`], { type: 'text/csv;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = `outlinks-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

document.addEventListener('DOMContentLoaded', async () => {
  bootAppShell(document, { currentUrl: window.location.href });

  element('outlinkFilterForm').addEventListener('submit', (event) => {
    event.preventDefault();
    activeFilter = readFilter();
    pageIndex = 0;
    selectedIds.clear();
    void loadPage();
  });
  element('resetFiltersBtn').addEventListener('click', () => {
    element('outlinkFilterForm').reset();
    activeFilter = {};
    pageIndex = 0;
    selectedIds.clear();
    void loadPage();
  });
  element('previousPageBtn').addEventListener('click', () => {
    if (pageIndex > 0) pageIndex -= 1;
    void loadPage();
  });
  element('nextPageBtn').addEventListener('click', () => {
    pageIndex += 1;
    void loadPage();
  });
  element('selectPage').addEventListener('change', (event) => {
    currentRecords.forEach((record) => {
      if (event.target.checked) selectedIds.add(record.id);
      else selectedIds.delete(record.id);
    });
    renderRows(currentRecords);
    updateSelectionControls();
  });
  element('deleteSelectedBtn').addEventListener('click', async () => {
    if (!selectedIds.size) return;
    await sendMessage({ type: 'OUTLINKS_DELETE', ids: [...selectedIds] });
    selectedIds.clear();
    await Promise.all([loadPage(), loadSummary()]);
  });
  element('clearAllBtn').addEventListener('click', async () => {
    if (!window.confirm('确定清空全部外链数据吗？此操作无法撤销。')) return;
    await sendMessage({ type: 'OUTLINKS_CLEAR' });
    selectedIds.clear();
    pageIndex = 0;
    await Promise.all([loadPage(), loadSummary()]);
  });
  element('exportCsvBtn').addEventListener('click', async () => {
    element('tableStatus').textContent = '正在生成 CSV…';
    try {
      const records = await sendMessage({
        type: 'OUTLINKS_EXPORT',
        filter: activeFilter
      });
      downloadCsv(records);
      element('tableStatus').textContent = `已导出 ${records.length} 条记录`;
    } catch (error) {
      element('tableStatus').textContent = error.message;
    }
  });

  await Promise.all([loadPage(), loadSummary()]);
});
