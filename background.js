import { installLlmMessageListener } from './lib/llm-message-listener.mjs';
import { installActionClickHandler } from './lib/action-click-handler.mjs';
import { openCommentHistoryDb } from './lib/comment-history-db.mjs';
import { createCommentHistoryService } from './lib/comment-history-service.mjs';
import { installCommentHistoryMessageListener } from './lib/comment-history-message-listener.mjs';
import { installCommentHistoryRetention } from './lib/comment-history-retention.mjs';

installLlmMessageListener(chrome);
installActionClickHandler(chrome);

let commentHistoryRepositoryPromise;

function getCommentHistoryRepository() {
  if (!commentHistoryRepositoryPromise) {
    commentHistoryRepositoryPromise = openCommentHistoryDb();
  }
  return commentHistoryRepositoryPromise;
}

async function callCommentHistoryRepository(method, args) {
  const repository = await getCommentHistoryRepository();
  return repository[method](...args);
}

const commentHistoryRepository = {
  upsertRecord: (...args) => callCommentHistoryRepository('upsertRecord', args),
  getRecord: (...args) => callCommentHistoryRepository('getRecord', args),
  queryRecords: (...args) => callCommentHistoryRepository('queryRecords', args),
  countRecords: (...args) => callCommentHistoryRepository('countRecords', args),
  getRetentionSummary: (...args) => callCommentHistoryRepository('getRetentionSummary', args),
  getExportChunk: (...args) => callCommentHistoryRepository('getExportChunk', args),
  deleteConfirmed: (...args) => callCommentHistoryRepository('deleteConfirmed', args),
  listArchiveEvents: (...args) => callCommentHistoryRepository('listArchiveEvents', args),
  getMeta: (...args) => callCommentHistoryRepository('getMeta', args),
  setMeta: (...args) => callCommentHistoryRepository('setMeta', args)
};

const commentHistoryService = createCommentHistoryService({
  repository: commentHistoryRepository,
  storageLocal: chrome.storage.local
});

installCommentHistoryMessageListener(chrome, commentHistoryService);
installCommentHistoryRetention(chrome, {
  getRetentionStatus: (...args) => commentHistoryService.getRetentionStatus(...args),
  getMeta: (...args) => commentHistoryRepository.getMeta(...args),
  setMeta: (...args) => commentHistoryRepository.setMeta(...args)
});

(async () => {
  try {
    await commentHistoryService.migrateLegacyResults();
  } catch (_) {
    console.warn('[background] Comment history legacy migration deferred');
  }
  try {
    await commentHistoryService.retryPendingWrites();
  } catch (_) {
    console.warn('[background] Comment history retry deferred');
  }
})();

/**
 * 将批量结果写入 storage（本地存储，由 batch.js 轮询读取）
 */
async function persistBatchReport(message) {
  const { batchId, urlIndex, url: pageUrl = '', result, aiContent, errorMessage } = message;
  console.log('[background] persistBatchReport >>>', { batchId, urlIndex, url: pageUrl, result, aiContentLen: aiContent ? aiContent.length : 0, errorMessage, time: new Date().toISOString() });

  const data = await chrome.storage.local.get(['batchResults', 'batchReportedUrls']);
  const results = Array.isArray(data.batchResults) ? data.batchResults : [];
  const entry = {
    batchId,
    urlIndex,
    url: pageUrl,
    result,
    aiContent,
    errorMessage,
    timestamp: Date.now()
  };
  const existingIndex = results.findIndex((item) => item.batchId === batchId && item.urlIndex === urlIndex);
  if (existingIndex >= 0) {
    results[existingIndex] = { ...results[existingIndex], ...entry };
  } else {
    results.push(entry);
  }
  if (results.length > 100) results.shift();

  let reported = data.batchReportedUrls || [];
  if (!Array.isArray(reported)) reported = [];
  const urlKey = `${batchId}:${urlIndex}`;
  if (!reported.includes(urlKey)) {
    reported.push(urlKey);
    if (reported.length > 500) reported.shift();
  }

  await chrome.storage.local.set({ batchResults: results, batchReportedUrls: reported });
  console.log('[background] persistBatchReport <<< 写入完成, 当前results长度:', results.length, 'time:', new Date().toISOString());
}

// content.js 确认评论已提交（标签页可能刷新，context 丢失，background 仍活着）
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'BATCH_HANDLE_CONFIRM') {
    console.log('[background] 收到 BATCH_HANDLE_CONFIRM >>>', { batchId: message.batchId, urlIndex: message.urlIndex, url: message.url, aiContentLen: message.aiContent ? message.aiContent.length : 0, sender: sender.tab ? sender.tab.id : 'N/A', time: new Date().toISOString() });
    (async () => {
      try {
        await persistBatchReport({
          batchId: message.batchId,
          urlIndex: message.urlIndex,
          url: message.url || '',
          result: message.result ?? 'success',
          aiContent: message.aiContent || null,
          errorMessage: message.errorMessage || null
        });
        console.log('[background] persistBatchReport 完成，准备发送 BATCH_CONFIRMED');

        const { historySaveStatus } = await commentHistoryService.saveConfirmedSuccess({
          ...message,
          result: message.result ?? 'success'
        });

        // 关键：先通知 batch.js（popup）落盘已完成，batch.js 等到确认后才关闭标签页
        // 再转发给 popup（batch.js），确保 batch.js 收到后再关 tab
        chrome.runtime.sendMessage({
          type: 'BATCH_CONFIRMED',
          urlIndex: message.urlIndex,
          result: message.result ?? 'success',
          aiContent: message.aiContent || null,
          errorMessage: message.errorMessage || null,
          historySaveStatus
        }).then(() => {
          console.log('[background] BATCH_CONFIRMED 发送成功');
        }).catch((e) => {
          if (e.message && e.message.includes('message channel closed')) {
            console.log('[background] BATCH_CONFIRMED 发送失败（接收方已关闭），忽略');
          } else {
            console.error('[background] BATCH_CONFIRMED 发送失败:', e);
          }
        });

        sendResponse({ ok: true, historySaveStatus });
        console.log('[background] BATCH_HANDLE_CONFIRM <<< sendResponse({ok:true})');
      } catch (e) {
        console.error('[background] BATCH_HANDLE_CONFIRM 错误:', e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});

// 批量任务结果：content / batch 页 -> background 持久化
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'BATCH_REPORT_RESULT') {
    console.log('[background] 收到 BATCH_REPORT_RESULT >>>', { batchId: message.batchId, urlIndex: message.urlIndex, result: message.result, sender: sender.tab ? sender.tab.id : 'N/A', time: new Date().toISOString() });
    (async () => {
      try {
        await persistBatchReport(message);
        console.log('[background] BATCH_REPORT_RESULT <<< sendResponse({ok:true})');
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[background] BATCH_REPORT_RESULT 错误:', e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});
