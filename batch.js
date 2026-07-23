import { loadLlmConfig } from './lib/llm-config.mjs';
import { getBatchStartError } from './lib/batch-readiness.mjs';
import {
  BatchScheduler,
  isBatchConfirmationFor,
  normalizeBatchConcurrency
} from './lib/batch-scheduler.mjs';
import { BatchWindowManager } from './lib/batch-window-manager.mjs';

// 批量外链评论自动化 - 扩展端核心逻辑（本地批次管理）

// ==================== 配置 ====================
const POLL_INTERVAL = 3000;
const TIMEOUT_CHECK_INTERVAL = 5000;
const TIMEOUT_STORAGE_KEY = 'batch_timeout_seconds';
const BATCH_CONCURRENCY_KEY = 'batch_concurrency';

// ==================== 状态 ====================
let batchId = null;
let parsedUrls = [];                // [{originalIndex, url}]
let status = 'idle';                // idle | running | completed
let scheduler = null;
let windowManager = null;
let openingActivities = new Map();
let isTerminated = false;

// 实时计数
let totalCount = 0;
let successCount = 0;
let failCount = 0;
let skippedCount = 0;
let noCommentBoxCount = 0;
let manualRequiredCount = 0;
let blockedIllegalCount = 0;
let pendingCount = 0;

// 本地结果存储
let localResults = [];              // [{originalIndex, url, result, aiContent, errorMessage, timestamp}]

// 轮询定时器
let pollTimer = null;

// 定时器
let timeoutCheckTimer = null;
let timeoutSeconds = 60;
let concurrency = 3;

// 已跳过（已存在评论）的 urlIndex 记录
let skippedIndices = new Set();

// ==================== DOM 引用 ====================
const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const fileCount = document.getElementById('fileCount');
const fileRemove = document.getElementById('fileRemove');
const urlPreview = document.getElementById('urlPreview');
const urlPreviewBody = document.getElementById('urlPreviewBody');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const progressSection = document.getElementById('progressSection');
const progressBar = document.getElementById('progressBar');
const successCountEl = document.getElementById('successCount');
const failCountEl = document.getElementById('failCount');
const skippedCountEl = document.getElementById('skippedCount');
const noCommentBoxCountEl = document.getElementById('statsNoCommentBox');
const manualRequiredCountEl = document.getElementById('manualRequiredCount');
const pendingCountEl = document.getElementById('pendingCount');
const progressText = document.getElementById('progressText');
const footerActions = document.getElementById('footerActions');
const exportBtn = document.getElementById('exportBtn');
const clearBtn = document.getElementById('clearBtn');
const statusBadge = document.getElementById('statusBadge');
const timeoutInput = document.getElementById('timeoutInput');
const concurrencyInput = document.getElementById('concurrencyInput');
const statsPanel = document.getElementById('statsPanel');
const statsTotal = document.getElementById('statsTotal');
const statsSuccess = document.getElementById('statsSuccess');
const statsSkipped = document.getElementById('statsSkipped');
const statsManualRequired = document.getElementById('statsManualRequired');
const statsNoCommentBox = document.getElementById('statsNoCommentBox');
const statsFail = document.getElementById('statsFail');
const statsRate = document.getElementById('statsRate');
const filterResult = document.getElementById('filterResult');
const filterDomain = document.getElementById('filterDomain');
const filterTimeRange = document.getElementById('filterTimeRange');
const filterKeyword = document.getElementById('filterKeyword');
const statsTableBody = document.getElementById('statsTableBody');
const statsTableWrap = document.getElementById('statsTableWrap');
const statsCountLabel = document.getElementById('statsCountLabel');

// 批量任务设置勾选框
const batchAutoOpenPanel = document.getElementById('batchAutoOpenPanel');
const batchAutoGenerate = document.getElementById('batchAutoGenerate');
const batchAutoSubmit = document.getElementById('batchAutoSubmit');

// ==================== 批量任务设置存储键 ====================
const BATCH_SETTINGS_KEY = 'batch_task_settings';
const BATCH_URLS_KEY = 'batch_task_urls';
const BATCH_DOMAIN_BLACKLIST = ['nsfw-ai.net'];

// 全局勾选框设置的 storage.sync 键
const BATCH_CHECKBOX_SETTINGS_KEY = 'batch_checkbox_settings';

// 加载全局勾选框设置
async function loadBatchCheckboxSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([BATCH_CHECKBOX_SETTINGS_KEY], (data) => {
      const saved = data[BATCH_CHECKBOX_SETTINGS_KEY] || {};
      batchAutoOpenPanel.checked = !!saved.autoOpenPanel;
      batchAutoGenerate.checked = !!saved.autoGenerate;
      batchAutoSubmit.checked = !!saved.autoSubmit;
      console.log('[batch] 已加载全局勾选框设置:', saved);
      resolve();
    });
  });
}

// 保存全局勾选框设置
async function saveBatchCheckboxSettings() {
  return new Promise((resolve) => {
    const settings = {
      autoOpenPanel: batchAutoOpenPanel.checked,
      autoGenerate: batchAutoGenerate.checked,
      autoSubmit: batchAutoSubmit.checked
    };
    chrome.storage.sync.set({
      [BATCH_CHECKBOX_SETTINGS_KEY]: settings
    }, () => {
      console.log('[batch] 全局勾选框设置已保存:', settings);
      resolve();
    });
  });
}

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', init);

async function init() {
  createWindowManager();
  await loadConcurrencySetting();
  await loadTimeoutSetting();
  await loadBatchCheckboxSettings(); // 全局记忆的勾选框设置
  bindEvents();

  updateUI();
}

function createWindowManager() {
  windowManager?.dispose();
  windowManager = new BatchWindowManager({
    windowsApi: chrome.windows,
    onUnexpectedClose: (activity) => {
      void handleUnexpectedWindowClose(activity);
    }
  });
}

async function loadConcurrencySetting() {
  const data = await chrome.storage.sync.get(BATCH_CONCURRENCY_KEY);
  concurrency = normalizeBatchConcurrency(data[BATCH_CONCURRENCY_KEY]);
  concurrencyInput.value = String(concurrency);
}

async function saveConcurrencySetting() {
  concurrency = normalizeBatchConcurrency(
    concurrencyInput.value,
    concurrency
  );
  concurrencyInput.value = String(concurrency);
  await chrome.storage.sync.set({ [BATCH_CONCURRENCY_KEY]: concurrency });
}

async function loadTimeoutSetting() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([TIMEOUT_STORAGE_KEY], (data) => {
      const saved = parseInt(data[TIMEOUT_STORAGE_KEY], 10);
      timeoutSeconds = (saved && saved >= 10 && saved <= 600) ? saved : 60;
      timeoutInput.value = String(timeoutSeconds);
      resolve();
    });
  });
}

// ==================== 事件绑定 ====================
function saveTimeoutSetting() {
  const val = parseInt(timeoutInput.value, 10);
  if (val >= 10 && val <= 600) {
    timeoutSeconds = val;
    chrome.storage.sync.set({ [TIMEOUT_STORAGE_KEY]: val });
  } else {
    timeoutInput.value = String(timeoutSeconds);
  }
}

// ==================== 事件绑定 ====================
function bindEvents() {
  // 上传区域
  uploadZone.addEventListener('click', () => fileInput.click());
  uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
  uploadZone.addEventListener('drop', handleFileDrop);
  fileInput.addEventListener('change', handleFileSelect);

  // 文件信息
  fileRemove.addEventListener('click', resetFile);

  // 操作按钮
  startBtn.addEventListener('click', () => {
    if (status === 'terminated') {
      resumeBatch();
    } else {
      startBatch();
    }
  });
  stopBtn.addEventListener('click', stopBatch);
  exportBtn.addEventListener('click', exportResults);
  clearBtn.addEventListener('click', clearBatch);

  // 设置
  timeoutInput.addEventListener('change', saveTimeoutSetting);
  concurrencyInput.addEventListener('change', saveConcurrencySetting);

  // 勾选框设置（全局记忆）
  batchAutoOpenPanel.addEventListener('change', saveBatchCheckboxSettings);
  batchAutoGenerate.addEventListener('change', saveBatchCheckboxSettings);
  batchAutoSubmit.addEventListener('change', saveBatchCheckboxSettings);

  // 监听 background 消息（结果回调）
  chrome.runtime.onMessage.addListener((message) => {
    // background 通知：结果已落盘，标签页可以安全关闭了
    if (!isBatchConfirmationFor(message, { batchId, totalCount })) return;

    console.log('[batch] 收到 BATCH_CONFIRMED >>>', {
      urlIndex: message.urlIndex,
      result: message.result,
      aiContentLen: message.aiContent ? message.aiContent.length : 0,
      time: new Date().toISOString()
    });
    void handleTaskConfirmed(
      message.urlIndex,
      message.result,
      message.aiContent,
      message.errorMessage
    );
  });

  // 统计筛选器
  filterResult.addEventListener('change', renderStats);
  filterDomain.addEventListener('change', renderStats);
  filterTimeRange.addEventListener('change', renderStats);
  filterKeyword.addEventListener('input', debounce(renderStats, 300));
}

// ==================== CSV 解析 ====================
function handleFileDrop(e) {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) processFile(file);
}

function handleFileSelect(e) {
  const file = e.target.files[0];
  if (file) processFile(file);
}

function processFile(file) {
  if (!file.name.endsWith('.csv')) {
    alert('请上传 CSV 文件');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    parseCSV(e.target.result, file.name);
  };
  reader.onerror = () => {
    alert('文件读取失败');
  };
  reader.readAsArrayBuffer(file);
}

function evaluateIllegalSiteForBatchItem(url, sourceDomain) {
  const filter = window.AutoCommentIllegalSiteFilter;
  if (!filter || typeof filter.evaluateUrl !== 'function') {
    console.warn('[batch] 非法网站过滤器未加载，跳过 URL 预检测');
    return { blocked: false };
  }
  return filter.evaluateUrl(url, { sourceDomain });
}

function getIllegalSiteBlockMessage(check) {
  if (!check || !check.blocked) return '';
  return check.reason || '非法网站拦截：命中赌博/色情规则';
}

function normalizeEncoding(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.length;

  // UTF-16 LE BOM: FF FE
  if (len >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.slice(2));
  }
  // UTF-16 BE BOM: FE FF
  if (len >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.slice(2));
  }
  // UTF-8 BOM: EF BB BF（已在 TextDecoder 自动跳过，但保险起见再剥一层）
  if (len >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.slice(3));
  }
  // 尝试检测 UTF-16 LE（无 BOM，但数据特征为每个 ASCII 后跟 00）
  if (len >= 4 && bytes[1] === 0x00 && bytes[3] === 0x00) {
    return new TextDecoder('utf-16le').decode(bytes);
  }

  // 检测 GBK/GB2312 编码：中文 GBK 双字节范围 0x81-0xFE
  let hasGBKSignature = false;
  for (let i = 0; i < len - 1; i++) {
    const b = bytes[i];
    if (b >= 0x81 && b <= 0xfe) {
      hasGBKSignature = true;
      break;
    }
  }

  // 优先尝试 UTF-8 解码（现代标准）
  const utf8Text = new TextDecoder('utf-8').decode(bytes);

  // 如果 UTF-8 解码后仍包含乱码特征（连续问号或方框），尝试 GBK
  if (hasGBKSignature && (utf8Text.includes('�') || utf8Text.includes('???') || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(utf8Text.slice(0, 100)))) {
    try {
      // 使用 GBK/GB2312/GB18030 解码
      const gbkText = new TextDecoder('gbk').decode(bytes);
      // 验证 GBK 解码结果是否包含有效中文（GBK 中常用汉字在 0xB0-0xF7 范围）
      const validChineseCount = (gbkText.match(/[\u4e00-\u9fa5]/g) || []).length;
      if (validChineseCount > 0) {
        return gbkText;
      }
    } catch (e) {
      // GBK 解码失败，回退到 UTF-8
    }
  }

  return utf8Text;
}

function parseCSV(raw, fileNameParam) {
  const text = normalizeEncoding(raw);
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) {
    alert('CSV 文件内容为空或格式错误');
    return;
  }

  // 去除 UTF-8 BOM（常见于从 Windows Excel 保存的文件）
  const headerRaw = lines[0];
  const header = parseCSVLine(headerRaw);
  const colUrl = header.findIndex((h) => h === '原URL' || h === 'URL' || h === 'url' || h === 'Url');
  const colDomain = header.findIndex((h) => h === 'URL对应域名' || h === '来源域名' || h === 'sourceDomain');

  if (colUrl === -1) {
    alert('CSV 文件缺少"原URL"列，请确认文件格式正确。\n\n标准格式应为：\n页面AS, 原URL, URL对应域名, 目标域名, 类型, 外部链接数量, 自动评论运行结果');
    resetFile();
    return;
  }

  let validCount = 0;
  let invalidCount = 0;
  let illegalCount = 0;
  let blacklistedCount = 0;
  parsedUrls = [];
  urlPreviewBody.innerHTML = '';

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    let url = (row[colUrl] || '').trim();
    let sourceDomain = colDomain >= 0 ? (row[colDomain] || '').trim() : '';

    if (!url) {
      invalidCount++;
      continue;
    }

    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }

    if (!isValidUrl(url)) {
      invalidCount++;
      continue;
    }

    if (isBatchDomainBlacklisted(url, sourceDomain)) {
      blacklistedCount++;
      continue;
    }

    const illegalCheck = evaluateIllegalSiteForBatchItem(url, sourceDomain);
    if (illegalCheck.blocked) {
      illegalCount++;
    }

    parsedUrls.push({
      originalIndex: parsedUrls.length,
      url,
      sourceDomain,
      illegalCheck: illegalCheck.blocked ? illegalCheck : null,
      originalRow: row  // 保存原始行数据，用于导出时保持格式
    });
    validCount++;

    const tr = document.createElement('tr');
    tr.dataset.url = url;
    if (illegalCheck.blocked) {
      tr.classList.add('illegal');
      tr.title = getIllegalSiteBlockMessage(illegalCheck);
    }
    tr.innerHTML = `<td>${parsedUrls.length}</td><td>${escapeHtml(sourceDomain || url)}</td><td>${escapeHtml(url)}</td>`;
    urlPreviewBody.appendChild(tr);
  }

  // 检测重复
  const seenUrls = new Set();
  let duplicateCount = 0;
  urlPreviewBody.querySelectorAll('tr').forEach((tr) => {
    const url = tr.dataset.url;
    if (seenUrls.has(url)) {
      tr.classList.add('duplicate');
      duplicateCount++;
    }
    seenUrls.add(url);
  });

  urlPreview.classList.add('visible');
  fileName.textContent = fileNameParam || '已上传文件';
  fileInfo.classList.add('visible');
  uploadZone.classList.add('has-file');
  fileCount.textContent = `共 ${validCount} 条 URL`;
  if (invalidCount > 0) fileCount.textContent += `（跳过 ${invalidCount} 条无效）`;
  if (illegalCount > 0) fileCount.textContent += `（非法拦截 ${illegalCount} 条）`;
  if (blacklistedCount > 0) fileCount.textContent += `（跳过 ${blacklistedCount} 条黑名单域名）`;
  if (duplicateCount > 0) {
    fileCount.textContent += `（发现 ${duplicateCount} 条重复）`;
    document.getElementById('duplicateCount').textContent = `⚠️ ${duplicateCount} 条重复`;
  }
  startBtn.disabled = validCount === 0;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function resetFile() {
  fileInput.value = '';
  fileInfo.classList.remove('visible');
  uploadZone.classList.remove('has-file');
  urlPreview.classList.remove('visible');
  urlPreviewBody.innerHTML = '';
  parsedUrls = [];
  startBtn.disabled = true;
  fileCount.textContent = '';
  document.getElementById('duplicateCount').textContent = '';
}

// ==================== 批量处理核心 ====================
async function startBatch() {
  const modelConfig = await loadLlmConfig(chrome.storage);
  const startError = getBatchStartError(modelConfig, parsedUrls.length);
  if (startError) {
    alert(startError);
    return;
  }

  await new Promise((resolve) => {
    chrome.storage.local.remove(['batchCtx'], resolve);
  });

  // 保存批量任务设置和 URL 列表到 storage.local，供 content.js 读取
  await saveBatchTaskSettings();

  batchId = generateUUID();
  totalCount = parsedUrls.length;
  successCount = 0;
  failCount = 0;
  skippedCount = 0;
  noCommentBoxCount = 0;
  manualRequiredCount = 0;
  blockedIllegalCount = 0;
  pendingCount = totalCount;
  localResults = [];
  skippedIndices.clear();
  scheduler = new BatchScheduler({
    totalCount,
    concurrency
  });
  scheduler.start();
  isTerminated = false;

  setStatus('running');
  updateUI();
  updateStatsUI();

  fillAvailableWindows();
}

// 保存批量任务设置到 storage.local
async function saveBatchTaskSettings() {
  return new Promise((resolve) => {
    const settings = {
      autoOpenPanel: batchAutoOpenPanel.checked,
      autoGenerate: batchAutoGenerate.checked,
      autoSubmit: batchAutoSubmit.checked,
      savedAt: Date.now()
    };
    const urls = parsedUrls.map(item => item.url);

    chrome.storage.local.set({
      [BATCH_SETTINGS_KEY]: settings,
      [BATCH_URLS_KEY]: urls
    }, () => {
      console.log('[batch] 批量任务设置已保存:', settings, 'URL 数量:', urls.length);
      resolve();
    });
  });
}

// 清除批量任务设置
async function clearBatchTaskSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([BATCH_SETTINGS_KEY, BATCH_URLS_KEY], () => {
      console.log('[batch] 批量任务设置已清除');
      resolve();
    });
  });
}

async function stopBatch() {
  isTerminated = true;
  scheduler?.stop();
  setStatus('terminated');

  const terminatedCount = pendingCount;
  if (pollTimer) clearTimeout(pollTimer);
  stopTimeoutChecker();

  const activeIndices = scheduler?.activeIndices || [];
  for (const urlIndex of activeIndices) {
    await finalizeTask(
      urlIndex,
      'fail',
      null,
      '手动终止',
      { suppressCompletion: true }
    );
  }
  await windowManager.closeAll();
  openingActivities.clear();

  updateStatsUI();
  updateUI();

  console.log(`[batch] 已手动终止。共保留 ${localResults.length} 条结果（成功 ${successCount}，失败 ${failCount}），跳过 ${terminatedCount} 条未处理`);
}

// 恢复处理（从终止状态继续）
async function resumeBatch() {
  console.log('[resumeBatch] 开始恢复处理', {
    status,
    totalCount,
    successCount,
    failCount
  });

  if (status !== 'terminated') {
    console.log('[resumeBatch] 状态不是 terminated，不执行');
    return;
  }

  const processedCount = getProcessedCount();
  pendingCount = totalCount - processedCount;
  const processedIndices = localResults.map((result) => result.originalIndex);
  scheduler = new BatchScheduler({
    totalCount,
    concurrency,
    processedIndices
  });
  scheduler.start();
  isTerminated = false;

  setStatus('running');
  updateUI();
  fillAvailableWindows();
}

function fillAvailableWindows() {
  if (status !== 'running' || isTerminated || !scheduler) return;
  const indices = scheduler.takeAvailable();
  for (const urlIndex of indices) {
    void openWorkerWindow(urlIndex);
  }
  checkAllCompleted();
}

async function openWorkerWindow(urlIndex) {
  const item = parsedUrls[urlIndex];
  if (!item) {
    await finalizeTask(
      urlIndex,
      'fail',
      null,
      'URL 数据不存在',
      { closeWindow: false }
    );
    return;
  }

  const illegalCheck = item.illegalCheck ||
    evaluateIllegalSiteForBatchItem(item.url, item.sourceDomain);
  if (illegalCheck.blocked) {
    item.illegalCheck = illegalCheck;
    await finalizeTask(
      urlIndex,
      'blocked_illegal',
      null,
      getIllegalSiteBlockMessage(illegalCheck),
      { closeWindow: false, forcedElapsed: 0 }
    );
    return;
  }

  const activityBatchId = batchId;
  const activityWindowManager = windowManager;
  const opening = {
    batchId: activityBatchId,
    startTime: Date.now()
  };
  openingActivities.set(urlIndex, opening);
  try {
    const activity = await windowManager.create({
      batchId: activityBatchId,
      urlIndex,
      url: item.url
    });
    const isCurrentBatch = batchId === activityBatchId &&
      windowManager === activityWindowManager;
    if (openingActivities.get(urlIndex) === opening) {
      openingActivities.delete(urlIndex);
    }
    if (
      !isCurrentBatch ||
      status !== 'running' ||
      isTerminated ||
      localResults.some((entry) => entry.originalIndex === urlIndex)
    ) {
      await activityWindowManager.closeByIndex(urlIndex);
      if (isCurrentBatch && scheduler) {
        scheduler.settle(urlIndex);
      }
      return;
    }
    highlightPreviewRow(urlIndex, 'processing');
    startTimeoutChecker();
    updateStatsUI();
    sendTaskWhenReady(activity);
  } catch (error) {
    if (openingActivities.get(urlIndex) === opening) {
      openingActivities.delete(urlIndex);
    }
    if (
      batchId !== activityBatchId ||
      windowManager !== activityWindowManager
    ) {
      return;
    }
    await finalizeTask(
      urlIndex,
      'fail',
      null,
      `窗口创建失败：${error.message || error}`,
      { closeWindow: false }
    );
  }
}

function sendTaskWhenReady(activity, retries = 0) {
  const { tabId, urlIndex, url } = activity;
  if (
    status !== 'running' ||
    isTerminated ||
    localResults.some((entry) => entry.originalIndex === urlIndex) ||
    windowManager.getByIndex(urlIndex) !== activity
  ) {
    return;
  }
  if (retries > 20) {
    if (!localResults.some((entry) => entry.originalIndex === urlIndex)) {
      void finalizeTask(
        urlIndex,
        'fail',
        null,
        'content.js 就绪超时'
      );
    }
    return;
  }

  chrome.tabs.sendMessage(tabId, { type: 'PING' }).then(() => {
    if (
      status !== 'running' ||
      isTerminated ||
      localResults.some((entry) => entry.originalIndex === urlIndex) ||
      windowManager.getByIndex(urlIndex) !== activity
    ) {
      return;
    }
    return chrome.tabs.sendMessage(tabId, {
      type: 'BATCH_HANDLE',
      batchId,
      urlIndex,
      url
    }).then((response) => {
      if (!response?.ok) {
        console.warn('[batch] content.js 响应 ok=false 或无响应:', response);
      }
    }).catch((error) => {
      if (!localResults.some((entry) => entry.originalIndex === urlIndex)) {
        void finalizeTask(
          urlIndex,
          'fail',
          null,
          `消息发送失败：${error.message || '标签页可能已关闭'}`
        );
      }
    });
  }).catch(() => {
    setTimeout(() => sendTaskWhenReady(activity, retries + 1), 500);
  });
}

function recordTaskResult(urlIndex, result, aiContent, errorMessage, elapsed) {
  console.log('[batch] recordTaskResult 被调用:', {
    urlIndex,
    result,
    aiContentLen: aiContent ? aiContent.length : 0,
    errorMessage
  });
  const item = parsedUrls[urlIndex];
  if (!item) {
    console.log('[batch] recordTaskResult: item 不存在, urlIndex=', urlIndex);
    return;
  }

  if (localResults.some((r) => r.originalIndex === urlIndex)) {
    console.log('[batch] recordTaskResult: 重复调用, urlIndex=', urlIndex);
    return;
  }

  const resultEntry = {
    originalIndex: urlIndex,
    url: item.url,
    sourceDomain: item.sourceDomain || '',
    result: result,
    aiContent: aiContent || null,
    errorMessage: errorMessage || null,
    timestamp: Date.now(),
    elapsed,
    originalRow: item.originalRow || null  // 保存原始行数据用于导出
  };

  localResults.push(resultEntry);

  if (result === 'success') {
    successCount++;
    highlightPreviewRow(urlIndex, 'success');
  } else if (result === 'skipped') {
    skippedCount++;
    skippedIndices.add(urlIndex);
    highlightPreviewRow(urlIndex, 'skipped');
  } else if (result === 'no_comment_box') {
    noCommentBoxCount++;
    highlightPreviewRow(urlIndex, 'no_comment_box');
  } else if (result === 'manual_required') {
    manualRequiredCount++;
    highlightPreviewRow(urlIndex, 'manual_required');
  } else if (result === 'blocked_illegal') {
    blockedIllegalCount++;
    highlightPreviewRow(urlIndex, 'blocked_illegal');
  } else {
    failCount++;
    highlightPreviewRow(urlIndex, 'fail');
  }

  pendingCount = totalCount - getProcessedCount();
  updateStatsUI();
  renderStats();

  // 保存到本地存储
  saveLocalResults();

  const processedCount = getProcessedCount();
  console.log('[batch] recordTaskResult 完成:', {
    urlIndex,
    result,
    successCount,
    failCount,
    skippedCount,
    manualRequiredCount,
    blockedIllegalCount,
    processedCount,
    totalCount
  });
}

async function finalizeTask(
  urlIndex,
  result,
  aiContent,
  errorMessage,
  {
    closeWindow = true,
    forcedElapsed,
    suppressCompletion = false
  } = {}
) {
  if (localResults.some((entry) => entry.originalIndex === urlIndex)) return false;

  const activity = windowManager?.getByIndex(urlIndex);
  const opening = openingActivities.get(urlIndex);
  const startTime = activity?.startTime || opening?.startTime;
  const elapsed = forcedElapsed !== undefined
    ? forcedElapsed
    : startTime
      ? Math.round((Date.now() - startTime) / 1000)
      : null;

  recordTaskResult(urlIndex, result, aiContent, errorMessage, elapsed);
  if (closeWindow) {
    await windowManager.closeByIndex(urlIndex);
  }
  openingActivities.delete(urlIndex);
  if (scheduler) {
    scheduler.settle(urlIndex);
  }

  if (!suppressCompletion && status === 'running' && !isTerminated) {
    fillAvailableWindows();
  }
  checkAllCompleted({ suppressCompletion });
  return true;
}

async function handleTaskConfirmed(urlIndex, result, aiContent, errorMessage) {
  await finalizeTask(urlIndex, result, aiContent, errorMessage);
}

async function handleUnexpectedWindowClose(activity) {
  if (activity.batchId !== batchId) return;
  await finalizeTask(
    activity.urlIndex,
    'fail',
    null,
    '用户手动关闭',
    { closeWindow: false }
  );
}

function getProcessedCount() {
  return successCount + failCount + skippedCount + noCommentBoxCount + manualRequiredCount + blockedIllegalCount;
}

function checkAllCompleted(options = {}) {
  const processedCount = getProcessedCount();
  const shouldComplete = !options.suppressCompletion &&
    status === 'running' &&
    totalCount > 0 &&
    processedCount >= totalCount;

  console.log('[batch] checkAllCompleted:', {
    processedCount,
    totalCount,
    activeIndices: scheduler?.activeIndices || [],
    status,
    shouldComplete
  });

  if (shouldComplete) {
    void onAllCompleted();
  }
}

// 保存结果到本地存储
function saveLocalResults() {
  chrome.storage.local.set({
    batchLocalResults: {
      batchId,
      totalCount,
      results: localResults.slice(-100) // 只保留最近100条
    }
  });
}

// 全部完成
async function onAllCompleted() {
  console.log('[batch] onAllCompleted 被调用!');
  if (status !== 'running') return;
  isTerminated = true;
  scheduler?.stop();
  setStatus('completed');
  stopTimeoutChecker();
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  await windowManager.closeAll();
  openingActivities.clear();

  updateStatsUI();
  updateUI();
}

// 超时检测
function startTimeoutChecker() {
  if (timeoutCheckTimer) return;
  timeoutCheckTimer = setInterval(() => {
    if (status !== 'running') {
      stopTimeoutChecker();
      return;
    }
    checkTimeouts();
  }, TIMEOUT_CHECK_INTERVAL);
}

function stopTimeoutChecker() {
  if (timeoutCheckTimer) {
    clearInterval(timeoutCheckTimer);
    timeoutCheckTimer = null;
  }
}

async function checkTimeouts() {
  const activeIndices = scheduler?.activeIndices || [];
  if (activeIndices.length === 0) {
    stopTimeoutChecker();
    return;
  }

  for (const urlIndex of activeIndices) {
    const activity = windowManager.getByIndex(urlIndex);
    const opening = openingActivities.get(urlIndex);
    const startTime = activity?.startTime || opening?.startTime;
    if (startTime && (Date.now() - startTime) / 1000 > timeoutSeconds) {
      await finalizeTask(urlIndex, 'fail', null, '处理超时');
    }
  }
}

// ==================== UI 更新 ====================
function setStatus(s) {
  status = s;
  statusBadge.textContent = {
    idle: '空闲',
    running: '运行中',
    completed: '已完成',
    terminated: '已终止'
  }[s] || s;
  statusBadge.className = 'status-badge ' + s;
}

function updateUI() {
  const isIdle = status === 'idle';
  const isRunning = status === 'running';
  const isCompleted = status === 'completed';
  const isTerminated = status === 'terminated';

  // 开始按钮：空闲时可开始，终止时可重新开始
  startBtn.disabled = isRunning || isCompleted || parsedUrls.length === 0;
  // 终止状态下显示"重新开始"，正常空闲显示"开始批量处理"
  startBtn.textContent = isTerminated ? '▶ 重新开始' : '▶ 开始批量处理';

  stopBtn.disabled = isIdle || isTerminated || isCompleted;
  stopBtn.style.display = (isTerminated || isCompleted) ? 'none' : 'inline-flex';

  exportBtn.disabled = localResults.length === 0;
  clearBtn.disabled = isRunning;
  concurrencyInput.disabled = isRunning;

  // 进度、实时日志、底部操作：终止状态保持显示
  progressSection.style.display = (isIdle) ? 'none' : 'block';
  footerActions.style.display = (isIdle) ? 'none' : 'flex';

  // 统计面板：终止状态保持显示（显示已处理的结果）
  if (isIdle) {
    statsPanel.classList.remove('visible');
    statsTableBody.innerHTML = '';
  } else if (localResults.length > 0) {
    statsPanel.classList.add('visible');
    renderStats();
  }

  // 终止状态下可重新开始，将待处理计数恢复
  if (isTerminated) {
    pendingCount = totalCount - getProcessedCount();
    updateStatsUI();
  }
}

function updateStatsUI() {
  const processed = getProcessedCount();
  const percent = totalCount > 0 ? Math.round((processed / totalCount) * 100) : 0;
  progressBar.style.width = percent + '%';
  progressText.textContent = `${processed}/${totalCount} (${percent}%)`;
  successCountEl.textContent = successCount;
  failCountEl.textContent = failCount;
  skippedCountEl.textContent = skippedCount;
  noCommentBoxCountEl.textContent = noCommentBoxCount;
  if (manualRequiredCountEl) manualRequiredCountEl.textContent = manualRequiredCount;
  pendingCountEl.textContent = pendingCount;
}

// ==================== 导出 ====================
function exportResults() {
  if (localResults.length === 0) {
    alert('没有可导出的结果');
    return;
  }

  // 查找第一条有原始行数据的结果来确定导入格式
  const sampleResult = localResults.find((r) => r.originalRow && r.originalRow.length > 0);
  if (!sampleResult) {
    alert('缺少导入数据，无法按原始格式导出');
    return;
  }

  const originalRowLen = getExportSourceColumnCount(sampleResult.originalRow);

  // 根据原始列数生成表头，保持与导入格式一致，最后加"运行结果"
  const originalHeaders = [];
  for (let i = 0; i < originalRowLen; i++) {
    if (i === 0) originalHeaders.push('页面AS');
    else if (i === 1) originalHeaders.push('原URL');
    else if (i === 2) originalHeaders.push('URL对应域名');
    else if (i === 3) originalHeaders.push('目标域名');
    else if (i === 4) originalHeaders.push('类型');
    else if (i === 5) originalHeaders.push('外部链接数量');
    else originalHeaders.push(`列${i + 1}`);
  }
  const header = [...originalHeaders, '运行结果'].join(',');

  const escape = (val) => {
    if (val == null) return '';
    const str = String(val);
    if (str.includes('"') || str.includes(',') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = localResults.map((r) => {
    // 基础列：页面AS=原序号-1，其他列从原始数据中取
    const baseCols = [];
    for (let i = 0; i < originalRowLen; i++) {
      baseCols.push(escape(r.originalRow[i] || ''));
    }
    const runResult = getExportRunResult(r.result);
    return [...baseCols, runResult].join(',');
  });

  const csv = [header, ...rows].join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `batch_result_${batchId}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function getExportSourceColumnCount(originalRow) {
  const len = originalRow.length;
  if (len <= 0) return 0;

  const lastValue = String(originalRow[len - 1] || '').trim();
  const knownResultValues = new Set(['√', '×', '需手动处理', '成功', '失败', '非法站点，已拦截']);
  if (knownResultValues.has(lastValue)) {
    return len - 1;
  }

  return len;
}

function getExportRunResult(result) {
  if (result === 'success' || result === 'skipped') return '√';
  if (result === 'manual_required') return '需手动处理';
  if (result === 'blocked_illegal') return '非法站点，已拦截';
  return '×';
}

function clearBatch() {
  resetFile();
  batchId = null;
  totalCount = successCount = failCount = skippedCount = noCommentBoxCount = manualRequiredCount = blockedIllegalCount = pendingCount = 0;
  localResults = [];
  scheduler = null;
  createWindowManager();
  openingActivities.clear();
  skippedIndices.clear();
  isTerminated = false;
  statsTableBody.innerHTML = '';
  statsTotal.textContent = '0';
  statsSuccess.textContent = '0';
  statsSkipped.textContent = '0';
  if (statsManualRequired) statsManualRequired.textContent = '0';
  statsNoCommentBox.textContent = '0';
  statsFail.textContent = '0';
  statsRate.textContent = '—';
  statsPanel.classList.remove('visible');
  filterDomain.innerHTML = '<option value="all">全部域名</option>';
  filterResult.value = 'all';
  filterTimeRange.value = 'all';
  filterKeyword.value = '';
  setStatus('idle');
  updateUI();
  chrome.storage.local.remove(['batchLocalResults', BATCH_SETTINGS_KEY, BATCH_URLS_KEY, 'batchCtx']);
}

// ==================== 统计面板 ====================

// 从 parsedUrls 找到对应行（用 data-url 属性查找）
function findPreviewRowByIndex(urlIndex) {
  const { url } = parsedUrls[urlIndex] || {};
  if (!url) return null;
  const rows = urlPreviewBody.querySelectorAll('tr');
  for (const row of rows) {
    if (row.dataset.url === url) return row;
  }
  return null;
}

function highlightPreviewRow(urlIndex, state) {
  const row = findPreviewRowByIndex(urlIndex);
  if (!row) return;
  row.classList.remove('url-processing', 'url-done-success', 'url-done-fail', 'url-done-skipped', 'url-done-blocked');
  if (state === 'processing') row.classList.add('url-processing');
  else if (state === 'success') row.classList.add('url-done-success');
  else if (state === 'fail') row.classList.add('url-done-fail');
  else if (state === 'skipped' || state === 'manual_required') row.classList.add('url-done-skipped');
  else if (state === 'blocked_illegal') row.classList.add('url-done-blocked');
}

function clearPreviewRow(urlIndex) {
  highlightPreviewRow(urlIndex, null);
}

function buildDomainOptions() {
  const domainMap = new Map();
  for (const r of localResults) {
    const domain = extractDomain(r.url);
    if (domain) domainMap.set(domain, (domainMap.get(domain) || 0) + 1);
  }
  const select = filterDomain;
  // 保留第一项 "全部域名"
  select.innerHTML = '<option value="all">全部域名</option>';
  for (const [domain, count] of [...domainMap.entries()].sort((a, b) => b[1] - a[1])) {
    const opt = document.createElement('option');
    opt.value = domain;
    opt.textContent = `${domain} (${count})`;
    select.appendChild(opt);
  }
}

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function normalizeBatchDomain(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';

  try {
    const url = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return text.replace(/^www\./i, '').split('/')[0].split(':')[0];
  }
}

function isDomainBlacklisted(domain) {
  const normalized = normalizeBatchDomain(domain);
  if (!normalized) return false;

  return BATCH_DOMAIN_BLACKLIST.some((blockedDomain) => {
    const blocked = normalizeBatchDomain(blockedDomain);
    return normalized === blocked || normalized.endsWith(`.${blocked}`);
  });
}

function isBatchDomainBlacklisted(url, sourceDomain) {
  return isDomainBlacklisted(extractDomain(url)) || isDomainBlacklisted(sourceDomain);
}

function filterTimeBucket(elapsedSecs) {
  const sel = filterTimeRange.value;
  if (sel === 'all') return true;
  if (elapsedSecs == null) return sel === '60+';
  if (sel === '0-5') return elapsedSecs <= 5;
  if (sel === '5-15') return elapsedSecs > 5 && elapsedSecs <= 15;
  if (sel === '15-30') return elapsedSecs > 15 && elapsedSecs <= 30;
  if (sel === '30-60') return elapsedSecs > 30 && elapsedSecs <= 60;
  if (sel === '60+') return elapsedSecs > 60;
  return true;
}

function renderStats() {
  if (localResults.length === 0) {
    statsPanel.classList.remove('visible');
    return;
  }
  statsPanel.classList.add('visible');

  const total = localResults.length;
  const success = localResults.filter((r) => r.result === 'success').length;
  const skipped = localResults.filter((r) => r.result === 'skipped').length;
  const fail = localResults.filter((r) => r.result === 'fail').length;
  const noCommentBox = localResults.filter((r) => r.result === 'no_comment_box').length;
  const manualRequired = localResults.filter((r) => r.result === 'manual_required').length;
  statsTotal.textContent = total;
  statsSuccess.textContent = success;
  statsSkipped.textContent = skipped;
  if (statsManualRequired) statsManualRequired.textContent = manualRequired;
  statsFail.textContent = fail;
  statsNoCommentBox.textContent = noCommentBox;
  // 成功率 = (成功 + 已存在) / 总数
  const validCount = success + skipped;
  const successRate = total > 0 ? Math.round((validCount / total) * 100) : 0;
  statsRate.textContent = total > 0 ? `${successRate}%` : '—';

  buildDomainOptions();

  const resultFilter = filterResult.value;
  const domainFilter = filterDomain.value;
  const kw = filterKeyword.value.trim().toLowerCase();

  const filtered = localResults.filter((r) => {
    if (resultFilter !== 'all' && r.result !== resultFilter) return false;
    if (domainFilter !== 'all' && extractDomain(r.url) !== domainFilter) return false;
    if (!filterTimeBucket(r.elapsed)) return false;
    if (kw) {
      const haystack = (r.url + ' ' + (r.aiContent || '') + ' ' + (r.errorMessage || '')).toLowerCase();
      if (!haystack.includes(kw)) return false;
    }
    return true;
  });

  statsCountLabel.textContent = `显示 ${filtered.length} / ${total} 条`;

  // 渲染表格（只重建 DOM，不重新请求）
  statsTableBody.innerHTML = '';
  for (const r of filtered) {
    const tr = document.createElement('tr');
    tr.className = `url-${r.result}`;

    const elapsedStr = r.elapsed != null ? r.elapsed + 's' : '—';
    const timeStr = r.timestamp ? formatTime(new Date(r.timestamp)) : '—';
    const shortUrl = r.url.length > 40 ? r.url.substring(0, 37) + '…' : r.url;

    const indexCell = document.createElement('td');
    indexCell.textContent = r.originalIndex + 1;
    indexCell.style.color = '#9ca3af';
    indexCell.style.textAlign = 'center';
    tr.appendChild(indexCell);

    const urlCell = document.createElement('td');
    urlCell.textContent = shortUrl;
    urlCell.title = r.url;
    tr.appendChild(urlCell);

    const resultCell = document.createElement('td');
    const resultBadge = document.createElement('span');
    resultBadge.className = `result-badge ${r.result}`;
    resultBadge.textContent = getResultText(r.result);
    resultCell.appendChild(resultBadge);
    tr.appendChild(resultCell);

    const errCell = document.createElement('td');
    if (r.errorMessage) {
      errCell.className = 'error-cell';
      errCell.textContent = r.errorMessage;
      errCell.title = r.errorMessage;
    } else {
      errCell.textContent = '—';
      errCell.style.color = '#d1d5db';
    }
    tr.appendChild(errCell);

    const aiCell = document.createElement('td');
    if (r.aiContent) {
      aiCell.className = 'ai-content-cell';
      aiCell.textContent = r.aiContent;
      aiCell.title = r.aiContent;
      aiCell.addEventListener('click', () => {
        aiCell.classList.toggle('expanded');
      });
    } else {
      aiCell.textContent = '—';
      aiCell.style.color = '#d1d5db';
    }
    tr.appendChild(aiCell);

    const elapsedCell = document.createElement('td');
    elapsedCell.textContent = elapsedStr;
    elapsedCell.style.fontSize = '11px';
    elapsedCell.style.color = '#9ca3af';
    elapsedCell.style.whiteSpace = 'nowrap';
    tr.appendChild(elapsedCell);

    const timeCell = document.createElement('td');
    timeCell.textContent = timeStr;
    timeCell.style.fontSize = '11px';
    timeCell.style.color = '#9ca3af';
    timeCell.style.whiteSpace = 'nowrap';
    tr.appendChild(timeCell);

    statsTableBody.appendChild(tr);
  }

  // 滚动到最新
  statsTableWrap.scrollTop = 0;
}

// ==================== 表单处理函数 ====================

/**
 * 在指定表单中查找评论相关元素
 * @param {HTMLFormElement} form - 要搜索的表单元素
 * @returns {Object} 包含表单统计和评论 textarea 的对象
 */
function findCommentForm(form) {
  if (!form) {
    console.log('[batch] findCommentForm: 表单为空');
    return { success: false, missingFields: ['form not found'] };
  }

  console.log('[batch] findCommentForm 最终使用的表单:', {
    id: form.id,
    className: form.className,
    action: form.action
  });

  // ── 步骤1：统计表单中所有输入框（用于日志）───────────────
  const formAllInputs = Array.from(form.querySelectorAll('input'));
  const formTextareas = Array.from(form.querySelectorAll('textarea'));
  console.log('[batch] 表单中的 input 数量:', formAllInputs.length, 'textarea 数量:', formTextareas.length);
  console.log('[batch] 表单中所有 input:', formAllInputs.map(i => ({
    name: i.name, id: i.id, type: i.type, className: i.className,
    placeholder: i.placeholder, valueLen: (i.value || '').length
  })));

  // ── 步骤2：找评论 textarea ───────────────────────────────
  let commentTextarea = null;
  if (formTextareas.length > 0) {
    // 优先找有 comment 关键词的
    commentTextarea = formTextareas.find(ta => {
      const n = (ta.name || '').toLowerCase();
      const i = (ta.id || '').toLowerCase();
      return n.includes('comment') || i.includes('comment');
    }) || formTextareas[0];
  }
  if (!commentTextarea) {
    // 再从全局找并验证属于当前表单
    const ta = findLikelyCommentTextarea({ allowGenericFallback: true });
    if (ta && (ta.form === form || (ta.closest && ta.closest('form') === form))) {
      commentTextarea = ta;
    }
  }

  if (!commentTextarea) {
    console.log('[batch] 未找到评论 textarea!');
    return { success: false, missingFields: ['comment textarea not found'] };
  }

  return {
    success: true,
    form: form,
    commentTextarea: commentTextarea,
    formAllInputs: formAllInputs,
    formTextareas: formTextareas
  };
}

/**
 * 全局查找可能的评论 textarea
 * @param {Object} options - 选项
 * @param {boolean} options.allowGenericFallback - 是否允许通用回退
 * @returns {Element|null} 评论 textarea 元素
 */
function findLikelyCommentTextarea(options) {
  const allowGenericFallback = options && options.allowGenericFallback;
  const allTextareas = Array.from(document.querySelectorAll('textarea'));
  if (allTextareas.length === 0) return null;

  const commentTextareas = [];

  // 方法1: 通过标准的 WordPress/comment 选择器直接查找
  const standardSelectors = [
    '#comment',
    'textarea[name="comment"]',
    'textarea#comment',
    'textarea[id="comment"]',
    'textarea[name="comment_content"]',
    'textarea[id="comment_content"]',
    'textarea[name="comments"]',
    'textarea#comments'
  ];

  for (const selector of standardSelectors) {
    try {
      const ta = document.querySelector(selector);
      if (ta && !commentTextareas.includes(ta)) {
        commentTextareas.push(ta);
      }
    } catch (e) {
      // 忽略无效选择器
    }
  }

  // 方法2: 通过关键词匹配
  if (commentTextareas.length === 0) {
    allTextareas.forEach((ta) => {
      if (commentTextareas.includes(ta)) return;

      const name = (ta.name || '').toLowerCase();
      const id = (ta.id || '').toLowerCase();
      const placeholder = (ta.placeholder || '').toLowerCase();
      const ariaLabel = (ta.getAttribute('aria-label') || '').toLowerCase();
      const text = `${name} ${id} ${placeholder} ${ariaLabel}`;

      const keywords = [
        'comment', 'reply', 'message', 'review', 'feedback', 'opinion',
        '留言', '评论', '回复', '响应',
        'leave a comment', 'write a comment', 'post a comment',
        'cancel reply', 'enter your comment', 'type here'
      ];

      if (keywords.some((k) => text.includes(k))) {
        commentTextareas.push(ta);
      }
    });
  }

  // 通用回退：返回第一个 textarea
  if (commentTextareas.length === 0 && allowGenericFallback && allTextareas.length > 0) {
    return allTextareas[0];
  }

  return commentTextareas.length > 0 ? commentTextareas[0] : null;
}

// ==================== 工具函数 ====================
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function getResultText(result) {
  switch (result) {
    case 'success': return '成功';
    case 'skipped': return '已存在';
    case 'manual_required': return '需手动处理';
    case 'no_comment_box': return '无评论框';
    case 'blocked_illegal': return '非法拦截';
    case 'fail': return '失败';
    default: return result;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
