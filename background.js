import { installLlmMessageListener } from './lib/llm-message-listener.mjs';
import { installActionClickHandler } from './lib/action-click-handler.mjs';
import { openCommentHistoryDb } from './lib/comment-history-db.mjs';
import { createCommentHistoryService } from './lib/comment-history-service.mjs';
import { installCommentHistoryMessageListener } from './lib/comment-history-message-listener.mjs';
import { installCommentHistoryRetention } from './lib/comment-history-retention.mjs';
import { createBatchResultStore } from './lib/batch-result-store.mjs';
import {
  createBatchRuntimeController,
  installBatchRuntimeController
} from './lib/batch-runtime-controller.mjs';
import {
  createBatchSubmitContextStore,
  installBatchSubmitContextListener
} from './lib/batch-submit-context-store.mjs';
import { isDurableBatchConfirmation } from './lib/batch-scheduler.mjs';

installLlmMessageListener(chrome);
installActionClickHandler(chrome);
const batchResultStore = createBatchResultStore(chrome.storage.local);
const batchRuntimeController = createBatchRuntimeController({
  storageArea: chrome.storage.local,
  power: chrome.power,
  tabs: chrome.tabs,
  windows: chrome.windows,
  runtime: chrome.runtime
});
installBatchRuntimeController(chrome, batchRuntimeController);
const batchSubmitContextStore = createBatchSubmitContextStore(
  chrome.storage.local,
  { maxAgeMs: Number.POSITIVE_INFINITY }
);
installBatchSubmitContextListener(chrome, batchSubmitContextStore);

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
  upsertIfFresher: (...args) => callCommentHistoryRepository('upsertIfFresher', args),
  insertLegacyIfAbsent: (...args) => (
    callCommentHistoryRepository('insertLegacyIfAbsent', args)
  ),
  getRecord: (...args) => callCommentHistoryRepository('getRecord', args),
  queryRecords: (...args) => callCommentHistoryRepository('queryRecords', args),
  countRecords: (...args) => callCommentHistoryRepository('countRecords', args),
  getRetentionSummary: (...args) => callCommentHistoryRepository('getRetentionSummary', args),
  getExportChunk: (...args) => callCommentHistoryRepository('getExportChunk', args),
  deleteConfirmed: (...args) => callCommentHistoryRepository('deleteConfirmed', args),
  deleteExportSessionAtomic: (...args) => (
    callCommentHistoryRepository('deleteExportSessionAtomic', args)
  ),
  listArchiveEvents: (...args) => callCommentHistoryRepository('listArchiveEvents', args),
  getMeta: (...args) => callCommentHistoryRepository('getMeta', args),
  setMeta: (...args) => callCommentHistoryRepository('setMeta', args)
};

const commentHistoryService = createCommentHistoryService({
  repository: commentHistoryRepository,
  storageLocal: chrome.storage.local
});

installCommentHistoryMessageListener(chrome, commentHistoryService);
const commentHistoryRetention = installCommentHistoryRetention(chrome, {
  getRetentionStatus: (...args) => commentHistoryService.getRetentionStatus(...args),
  getMeta: (...args) => commentHistoryRepository.getMeta(...args),
  setMeta: (...args) => commentHistoryRepository.setMeta(...args)
}, {
  startImmediately: false
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
  try {
    await commentHistoryRetention.checkNow();
  } catch (_) {
    console.warn('[background] Comment history retention check deferred');
  }
})();

/**
 * 将批量结果写入 storage（本地存储，由 batch.js 轮询读取）
 */
async function persistBatchReport(message) {
  await batchResultStore.save(message);
}

async function broadcastBatchConfirmed(
  message,
  { historySaveStatus, historyPendingCount, sourceTabId } = {}
) {
  const checkpoint = await batchRuntimeController.markTerminal(message);
  if (!checkpoint.ok) {
    throw new Error(`checkpoint_write_failed:${checkpoint.error}`);
  }
  await chrome.runtime.sendMessage({
    type: 'BATCH_CONFIRMED',
    batchId: message.batchId,
    urlIndex: message.urlIndex,
    attempt: message.attempt,
    result: message.result ?? 'success',
    aiContent: message.aiContent || null,
    errorMessage: message.errorMessage || null,
    ...(historySaveStatus ? { historySaveStatus } : {}),
    ...(Number.isInteger(historyPendingCount) || historyPendingCount === null
      ? { historyPendingCount }
      : {}),
    ...(Number.isInteger(sourceTabId) ? { sourceTabId } : {})
  }).then(() => {
    console.log('[background] BATCH_CONFIRMED 发送成功');
  }).catch((e) => {
    if (e.message && e.message.includes('message channel closed')) {
      console.log('[background] BATCH_CONFIRMED 发送失败（接收方已关闭），忽略');
    } else {
      console.error('[background] BATCH_CONFIRMED 发送失败:', e);
    }
  });
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

        const {
          historySaveStatus,
          pendingCount: historyPendingCount
        } = await commentHistoryService.saveConfirmedSuccess({
          ...message,
          result: message.result ?? 'success'
        });

        // 关键：先通知 batch.js（popup）落盘已完成，batch.js 等到确认后才关闭标签页
        const confirmedMessage = {
          ...message,
          historySaveStatus,
          historyPendingCount
        };
        if (isDurableBatchConfirmation(confirmedMessage)) {
          const result = message.result ?? 'success';
          let submitContextReleased = result !== 'success';
          if (result === 'success' && Number.isInteger(sender?.tab?.id)) {
            try {
              submitContextReleased = await batchSubmitContextStore.clearIfMatches(
                sender.tab.id,
                {
                  batchId: message.batchId,
                  urlIndex: message.urlIndex,
                  historyRevision: message.history?.historyRevision
                }
              );
            } catch (_) {
              console.warn('[background] Durable history saved but submit context cleanup deferred');
            }
          }
          if (submitContextReleased) {
            await broadcastBatchConfirmed(message, {
              historySaveStatus,
              historyPendingCount,
              sourceTabId: sender?.tab?.id
            });
          } else {
            sendResponse({
              ok: false,
              error: 'submit_context_not_released',
              historySaveStatus,
              ...(Number.isInteger(historyPendingCount) || historyPendingCount === null
                ? { historyPendingCount }
                : {})
            });
            return;
          }
        }

        sendResponse({
          ok: true,
          historySaveStatus,
          ...(Number.isInteger(historyPendingCount) || historyPendingCount === null
            ? { historyPendingCount }
            : {})
        });
        console.log('[background] BATCH_HANDLE_CONFIRM <<< sendResponse({ok:true})');
      } catch (e) {
        console.error('[background] BATCH_HANDLE_CONFIRM 错误:', e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});

// content.js 已把精确历史写入不可变 pending 队列，可以安全释放对应窗口。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'BATCH_HISTORY_FALLBACK_DURABLE') {
    if (!Number.isInteger(sender?.tab?.id)) {
      sendResponse({ ok: false, error: 'missing_sender_tab' });
      return false;
    }
    (async () => {
      try {
        let submitContextReleased = false;
        submitContextReleased = await batchSubmitContextStore.clearIfMatches(
          sender.tab.id,
          {
            batchId: message.batchId,
            urlIndex: message.urlIndex,
            historyRevision: message.historyRevision
          }
        );
        if (!submitContextReleased) {
          sendResponse({
            ok: false,
            error: 'submit_context_not_released'
          });
          return;
        }
        await broadcastBatchConfirmed(message, {
          historySaveStatus: 'queued',
          historyPendingCount: null,
          sourceTabId: sender.tab.id
        });
        sendResponse({ ok: true });
      } catch (error) {
        console.warn('[background] Fallback history handoff deferred');
        sendResponse({
          ok: false,
          error: error?.message?.startsWith('checkpoint_write_failed:')
            ? 'checkpoint_write_failed'
            : 'submit_context_not_released'
        });
      }
    })();
    return true;
  }
});

// 提交前待确认结果：仅持久化，不能提前释放 batch.js 的窗口槽位。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'BATCH_PERSIST_PENDING_RESULT') {
    (async () => {
      try {
        await batchResultStore.save(message);
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[background] BATCH_PERSIST_PENDING_RESULT 错误:', e);
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
        const tabId = sender?.tab?.id;
        const submitContext = Number.isInteger(tabId)
          ? await batchSubmitContextStore.get(tabId)
          : null;
        const hasUnacknowledgedSubmission = Boolean(
          message.result === 'fail'
          && submitContext
          && submitContext.batchId === message.batchId
          && submitContext.urlIndex === message.urlIndex
        );
        if (hasUnacknowledgedSubmission) {
          sendResponse({ ok: true, deferred: true });
          return;
        }
        await broadcastBatchConfirmed(message, { sourceTabId: tabId });
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
