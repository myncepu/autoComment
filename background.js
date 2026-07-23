import { installLlmMessageListener } from './lib/llm-message-listener.mjs';
import { installActionClickHandler } from './lib/action-click-handler.mjs';
import { createBatchResultStore } from './lib/batch-result-store.mjs';

installLlmMessageListener(chrome);
installActionClickHandler(chrome);
const batchResultStore = createBatchResultStore(chrome.storage.local);

/**
 * 将批量结果写入 storage（本地存储，由 batch.js 轮询读取）
 */
async function persistBatchReport(message) {
  await batchResultStore.save(message);
}

function broadcastBatchConfirmed(message) {
  chrome.runtime.sendMessage({
    type: 'BATCH_CONFIRMED',
    batchId: message.batchId,
    urlIndex: message.urlIndex,
    result: message.result || 'success',
    aiContent: message.aiContent || null,
    errorMessage: message.errorMessage || null
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
          result: message.result || 'success',
          aiContent: message.aiContent || null,
          errorMessage: message.errorMessage || null
        });
        console.log('[background] persistBatchReport 完成，准备发送 BATCH_CONFIRMED');

        // 关键：先通知 batch.js（popup）落盘已完成，batch.js 等到确认后才关闭标签页
        broadcastBatchConfirmed(message);

        sendResponse({ ok: true });
        console.log('[background] BATCH_HANDLE_CONFIRM <<< sendResponse({ok:true})');
      } catch (e) {
        console.error('[background] BATCH_HANDLE_CONFIRM 错误:', e);
        sendResponse({ ok: false, error: String(e) });
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
        broadcastBatchConfirmed(message);
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
