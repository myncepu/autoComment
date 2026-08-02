import { installLlmMessageListener } from './lib/llm-message-listener.mjs';
import { installActionClickHandler } from './lib/action-click-handler.mjs';
import { openCommentHistoryDb } from './lib/comment-history-db.mjs';
import { createCommentHistoryService } from './lib/comment-history-service.mjs';
import { installCommentHistoryMessageListener } from './lib/comment-history-message-listener.mjs';
import { installCommentHistoryRetention } from './lib/comment-history-retention.mjs';
import { installCloudSyncMessageListener } from './lib/cloud-sync-message-listener.mjs';
import {
  createCloudRetentionService,
  createCloudSyncRuntime,
  createLazyCloudSyncRepository,
  installCloudSyncBackground
} from './lib/cloud-sync-background.mjs';
import { migratePasswordToLocal } from './lib/cloud-sync-settings.mjs';
import { cloudQueueStatusFields } from './lib/cloud-sync-batch-status.mjs';
import { createBatchResultStore } from './lib/batch-result-store.mjs';
import {
  createBatchRuntimeController,
  installBatchRuntimeController
} from './lib/batch-runtime-controller.mjs';
import {
  createBatchDiagnosticService,
  installBatchDiagnosticListener
} from './lib/batch-diagnostic-log.mjs';
import {
  createBatchDeadlineWatchdog
} from './lib/batch-deadline-watchdog.mjs';
import { createDomainConfigRepository } from './lib/domain-config-repository.mjs';
import {
  installDomainConfigRepositoryMessageListener
} from './lib/domain-config-repository-message.mjs';
import {
  installBatchDomainConfigListener
} from './lib/batch-domain-config-listener.mjs';
import { createProfileSecretRepository } from './lib/profile-secret-repository.mjs';
import {
  installProfileSecretMessageListener
} from './lib/profile-secret-message-listener.mjs';
import { migrateLegacyDomainConfig } from './lib/domain-config-migration.mjs';
import {
  createBatchSecretAwareRuntimeController,
  createBatchSecretVaultStore,
  installBatchSecretVaultListener
} from './lib/batch-secret-vault.mjs';
import {
  createBatchSessionJournal
} from './lib/batch-session-journal.mjs';
import {
  createBatchSubmitContextStore,
  createSubmitContextMatch,
  installBatchSubmitContextListener
} from './lib/batch-submit-context-store.mjs';
import { isDurableBatchConfirmation } from './lib/batch-scheduler.mjs';
import { installLocalDebugBridge } from './lib/local-debug-bridge.mjs';
import {
  createInitializationAwareBatchRuntimeController,
  createRetryableReadiness
} from './lib/retryable-readiness.mjs';
import {
  isBenignRuntimeDeliveryError
} from './lib/chrome-runtime-delivery.mjs';
import {
  installLocalControlPoller
} from './lib/local-control-poller.mjs';

installLlmMessageListener(chrome);
installActionClickHandler(chrome);
const batchResultStore = createBatchResultStore(chrome.storage.local);
const domainConfigRepository = createDomainConfigRepository(chrome.storage.local);
const profileSecretRepository = createProfileSecretRepository(chrome.storage.local);
const batchSecretVaultStore = createBatchSecretVaultStore(chrome.storage.local);
const batchSubmitContextStore = createBatchSubmitContextStore(
  chrome.storage.local,
  { maxAgeMs: Number.POSITIVE_INFINITY }
);
void batchSubmitContextStore.pruneExpired().catch(() => {
  console.warn('[background] Submit-context retention cleanup deferred');
});
const ensureDomainConfigReady = createRetryableReadiness(async () => {
  await migratePasswordToLocal(chrome.storage);
  return migrateLegacyDomainConfig({
    storage: chrome.storage,
    configRepository: domainConfigRepository,
    secretRepository: profileSecretRepository
  });
});
const batchRuntimeController = createBatchRuntimeController({
  storageArea: chrome.storage.local,
  sessionJournal: createBatchSessionJournal(chrome.storage.session),
  power: chrome.power,
  tabs: chrome.tabs,
  windows: chrome.windows,
  runtime: chrome.runtime,
  loadDomainConfig: async () => {
    await ensureDomainConfigReady();
    return domainConfigRepository.load();
  },
  loadRecentSuccessUrls: () => (
    commentHistoryService.listRecentSuccessfulTargetUrls({
      since: Date.now() - (24 * 60 * 60 * 1000)
    })
  ),
  prepareStartStoragePatch: async ({
    checkpoint,
    eligibleProfileIds
  }) => {
    await ensureDomainConfigReady();
    const entry = await batchSecretVaultStore.buildPreparedEntry(
      checkpoint.batchId,
      eligibleProfileIds,
      profileSecretRepository
    );
    return batchSecretVaultStore.buildStoragePatch(
      checkpoint.batchId,
      entry
    );
  },
  cleanupPreparedStart: ({ batchId }) => (
    batchSecretVaultStore.clear(batchId)
  ),
  recoverRemovedSubmitContext: ({ tabId, expected, reason }) => (
    batchSubmitContextStore.sealAndRecover(tabId, expected, reason)
  )
});
const batchDiagnosticService = createBatchDiagnosticService({
  storageArea: chrome.storage.local,
  runtime: chrome.runtime
});
installBatchDiagnosticListener(chrome, batchDiagnosticService);
createBatchDeadlineWatchdog({
  alarms: chrome.alarms,
  storageArea: chrome.storage.local,
  storageChanged: chrome.storage.onChanged,
  runtimeController: batchRuntimeController,
  runtime: chrome.runtime,
  diagnosticService: batchDiagnosticService
}).start();
const initializationAwareBatchRuntimeController =
  createInitializationAwareBatchRuntimeController(
    batchRuntimeController,
    ensureDomainConfigReady
  );
installBatchSubmitContextListener(chrome, batchSubmitContextStore, {
  runProofBoundTaskHook: (...args) => (
    initializationAwareBatchRuntimeController.runProofBoundTaskHook(...args)
  ),
  runOwnerPageRecoveryHook: (...args) => (
    initializationAwareBatchRuntimeController.runOwnerPageRecoveryHook(...args)
  )
});

const commentHistoryRepository = createLazyCloudSyncRepository(
  () => openCommentHistoryDb()
);

const cloudSyncService = createCloudSyncRuntime({
  repository: commentHistoryRepository,
  domainConfigRepository,
  storage: chrome.storage,
  fetchImpl: fetch
});
const secretAwareBatchRuntimeController = createBatchSecretAwareRuntimeController(
  initializationAwareBatchRuntimeController,
  batchSecretVaultStore
);
installDomainConfigRepositoryMessageListener(
  chrome,
  domainConfigRepository,
  { ready: ensureDomainConfigReady }
);
installProfileSecretMessageListener(
  chrome,
  profileSecretRepository,
  { ready: ensureDomainConfigReady }
);

const commentHistoryService = createCommentHistoryService({
  repository: commentHistoryRepository,
  storageLocal: chrome.storage.local,
  cloudSync: cloudSyncService
});

installCommentHistoryMessageListener(chrome, commentHistoryService);
installBatchRuntimeController(chrome, secretAwareBatchRuntimeController);
const localDebugBridge = installLocalDebugBridge(chrome, {
  batchRuntimeController: initializationAwareBatchRuntimeController
});
installLocalControlPoller(chrome, {
  bridge: localDebugBridge.bridge
});
installBatchDomainConfigListener(chrome, domainConfigRepository, {
  ready: ensureDomainConfigReady
});
installBatchSecretVaultListener(chrome, {
  vaultStore: batchSecretVaultStore,
  checkpointReader: async () => {
    const response = await initializationAwareBatchRuntimeController.handleMessage({
      type: 'BATCH_SESSION_GET'
    });
    return response.ok ? response.checkpoint : null;
  }
});
installCloudSyncMessageListener(chrome, cloudSyncService);
if (typeof chrome.storage?.onChanged?.addListener === 'function') {
  void installCloudSyncBackground(chrome, cloudSyncService, {
    migrateDomainConfig: ensureDomainConfigReady
  });
}
void ensureDomainConfigReady()
  .then(() => (
    initializationAwareBatchRuntimeController.handleMessage({
      type: 'BATCH_SESSION_GET'
    })
  ))
  .then((response) => {
    if (response.ok) {
      return batchSecretVaultStore.cleanupOrphans(response.checkpoint);
    }
    return undefined;
  })
  .catch(() => {
    console.warn('[background] Batch secret cleanup deferred');
  });
const commentHistoryRetention = installCommentHistoryRetention(
  chrome,
  createCloudRetentionService({
    commentHistoryService,
    cloudSyncService,
    repository: commentHistoryRepository
  }),
  {
    startImmediately: false
  }
);

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

function batchIngressError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function submitContextMatches(context, message) {
  if (!context) return false;
  let expected;
  try {
    expected = createSubmitContextMatch(message);
  } catch (_) {
    return false;
  }
  return [
    'batchId',
    'taskId',
    'urlIndex',
    'profileId',
    'promotionSiteId',
    'attempt'
  ].every((field) => context[field] === expected[field]);
}

async function clearExactSubmitContext(message, sender) {
  if (!Number.isInteger(sender?.tab?.id)) {
    throw batchIngressError('missing_sender_tab');
  }
  let released = false;
  try {
    released = await batchSubmitContextStore.clearIfMatches(
      sender.tab.id,
      createSubmitContextMatch(message)
    );
    if (!released) {
      released = await batchSubmitContextStore.get(sender.tab.id) === null;
    }
  } catch (_) {
    console.warn('[background] Durable history saved but submit context cleanup deferred');
  }
  if (!released) {
    throw batchIngressError('submit_context_not_released');
  }
}

async function saveDurableHistory(message, sender) {
  const {
    historySaveStatus,
    pendingCount: historyPendingCount,
    cloudQueueStatus
  } = await commentHistoryService.saveConfirmedSuccess({
    ...message,
    result: message.result ?? 'success'
  });
  if (!isDurableBatchConfirmation({
    ...message,
    historySaveStatus,
    historyPendingCount
  })) {
    throw batchIngressError('history_save_failed');
  }
  await clearExactSubmitContext(message, sender);
  return {
    historySaveStatus,
    ...cloudQueueStatusFields(cloudQueueStatus),
    ...(cloudQueueStatus ? { cloudQueueStatus } : {}),
    ...(Number.isInteger(historyPendingCount) ||
      historyPendingCount === null
      ? { historyPendingCount }
      : {})
  };
}

async function broadcastBatchConfirmed(
  message,
  {
    historySaveStatus,
    historyPendingCount,
    cloudQueueStatus,
    sourceTabId,
    sender,
    terminalSideEffect
  } = {}
) {
  const checkpoint = await initializationAwareBatchRuntimeController.markTerminal(
    message,
    sender,
    terminalSideEffect
  );
  if (!checkpoint.ok) {
    const error = new Error(
      `checkpoint_write_failed:${checkpoint.error}`
    );
    error.code = checkpoint.error;
    throw error;
  }
  const sideEffect = checkpoint.sideEffect || {};
  const effectiveHistorySaveStatus =
    sideEffect.historySaveStatus ?? historySaveStatus;
  const effectiveHistoryPendingCount =
    Object.hasOwn(sideEffect, 'historyPendingCount')
      ? sideEffect.historyPendingCount
      : historyPendingCount;
  const effectiveCloudQueueStatus =
    sideEffect.cloudQueueStatus ?? cloudQueueStatus;
  if (
    checkpoint.changed === false &&
    typeof terminalSideEffect === 'function'
  ) {
    return {
      checkpoint,
      historySaveStatus: effectiveHistorySaveStatus,
      historyPendingCount: effectiveHistoryPendingCount,
      ...(effectiveCloudQueueStatus
        ? { cloudQueueStatus: effectiveCloudQueueStatus }
      : {})
    };
  }
  const committedResult = checkpoint.checkpoint?.results?.find(
    (result) => (
      result.originalIndex === message.urlIndex &&
      result.attempt === message.attempt
    )
  );
  await chrome.runtime.sendMessage({
    type: 'BATCH_CONFIRMED',
    batchId: message.batchId,
    urlIndex: message.urlIndex,
    attempt: message.attempt,
    result: message.result ?? 'success',
    aiContent: message.aiContent || null,
    errorCode: message.errorCode || null,
    errorMessage: message.errorMessage || null,
    resultPreview: {
      commentText: committedResult?.commentText ?? null,
      anchorTexts: Array.isArray(committedResult?.anchorTexts)
        ? committedResult.anchorTexts
        : [],
      promotedWebsiteUrl: committedResult?.promotedWebsiteUrl ?? null
    },
    ...(effectiveHistorySaveStatus
      ? { historySaveStatus: effectiveHistorySaveStatus }
      : {}),
    ...(
      Number.isInteger(effectiveHistoryPendingCount) ||
      effectiveHistoryPendingCount === null
      ? { historyPendingCount: effectiveHistoryPendingCount }
      : {}),
    ...cloudQueueStatusFields(effectiveCloudQueueStatus),
    ...(Number.isInteger(sourceTabId) ? { sourceTabId } : {})
  }).then(() => {
    console.log('[background] BATCH_CONFIRMED 发送成功');
  }).catch((e) => {
    if (isBenignRuntimeDeliveryError(e)) {
      console.log('[background] BATCH_CONFIRMED 发送失败（接收方已关闭），忽略');
    } else {
      console.error('[background] BATCH_CONFIRMED 发送失败:', e);
    }
  });
  return {
    checkpoint,
    historySaveStatus: effectiveHistorySaveStatus,
    historyPendingCount: effectiveHistoryPendingCount,
    ...(effectiveCloudQueueStatus
      ? { cloudQueueStatus: effectiveCloudQueueStatus }
      : {})
  };
}

// content.js 确认评论已提交（标签页可能刷新，context 丢失，background 仍活着）
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'BATCH_HANDLE_CONFIRM') {
    console.log('[background] 收到 BATCH_HANDLE_CONFIRM >>>', {
      batchId: message.batchId,
      urlIndex: message.urlIndex,
      aiContentLength: message.aiContent ? message.aiContent.length : 0,
      senderTabId: sender.tab?.id ?? null
    });
    (async () => {
      try {
        const committed = await broadcastBatchConfirmed(message, {
          sourceTabId: sender?.tab?.id,
          sender,
          async terminalSideEffect() {
            await persistBatchReport({
              batchId: message.batchId,
              urlIndex: message.urlIndex,
              attempt: message.attempt,
              url: message.url || '',
              result: message.result ?? 'success',
              aiContent: message.aiContent || null,
              errorCode: message.errorCode || null,
              errorMessage: message.errorMessage || null
            });
            console.log('[background] persistBatchReport 完成，准备发送 BATCH_CONFIRMED');
            return saveDurableHistory(message, sender);
          }
        });
        const {
          historySaveStatus,
          historyPendingCount,
          cloudQueueStatus
        } = committed;

        sendResponse({
          ok: true,
          historySaveStatus,
          ...cloudQueueStatusFields(cloudQueueStatus),
          ...(Number.isInteger(historyPendingCount) || historyPendingCount === null
            ? { historyPendingCount }
            : {})
        });
        console.log('[background] BATCH_HANDLE_CONFIRM <<< sendResponse({ok:true})');
      } catch (e) {
        console.error('[background] BATCH_HANDLE_CONFIRM 错误:', e);
        if (e?.code === 'history_save_failed') {
          sendResponse({
            ok: true,
            historySaveStatus: 'failed'
          });
          return;
        }
        sendResponse({
          ok: false,
          error: e?.code || String(e)
        });
      }
    })();
    return true;
  }
});

// background 在 ownership-proven terminal hook 内保存精确历史并释放窗口。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'BATCH_HISTORY_PENDING_FALLBACK') {
    (async () => {
      try {
        const committed = await broadcastBatchConfirmed(message, {
          sourceTabId: sender?.tab?.id,
          sender,
          terminalSideEffect: () => saveDurableHistory(message, sender)
        });
        sendResponse({
          ok: true,
          historySaveStatus: committed.historySaveStatus,
          ...cloudQueueStatusFields(committed.cloudQueueStatus),
          ...(Number.isInteger(committed.historyPendingCount) ||
            committed.historyPendingCount === null
            ? { historyPendingCount: committed.historyPendingCount }
            : {})
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error?.code || 'history_pending_fallback_failed'
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
        const response =
          await initializationAwareBatchRuntimeController.runProofBoundTaskHook(
            message,
            sender,
            () => batchResultStore.save(message)
          );
        if (!response.ok) {
          sendResponse({
            ok: false,
            error: response.error
          });
          return;
        }
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[background] BATCH_PERSIST_PENDING_RESULT 错误:', e);
        sendResponse({
          ok: false,
          error: e?.code || 'pending_result_write_failed'
        });
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
        const tabId = sender?.tab?.id;
        await broadcastBatchConfirmed(message, {
          sourceTabId: tabId,
          sender,
          async terminalSideEffect() {
            const submitContext = Number.isInteger(tabId)
              ? await batchSubmitContextStore.get(tabId)
              : null;
            if (
              message.result === 'fail' &&
              submitContextMatches(submitContext, message)
            ) {
              throw batchIngressError('submit_context_unresolved');
            }
            if (submitContext) {
              throw batchIngressError('submit_context_not_released');
            }
            await persistBatchReport(message);
            return saveDurableHistory(message, sender);
          }
        });
        console.log('[background] BATCH_REPORT_RESULT <<< sendResponse({ok:true})');
        sendResponse({ ok: true });
      } catch (e) {
        if (e?.code === 'submit_context_unresolved') {
          console.log(
            '[background] BATCH_REPORT_RESULT 延迟：提交上下文尚待确认'
          );
          sendResponse({ ok: true, deferred: true });
          return;
        }
        console.error('[background] BATCH_REPORT_RESULT 错误:', e);
        sendResponse({
          ok: false,
          error: e?.code || 'batch_report_failed'
        });
      }
    })();
    return true;
  }
});
