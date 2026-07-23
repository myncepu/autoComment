export const HISTORY_MESSAGE_TYPES = Object.freeze({
  SUMMARY: 'HISTORY_SUMMARY',
  LIST: 'HISTORY_LIST',
  ANCHORS: 'HISTORY_ANCHORS',
  EXPORT_START: 'HISTORY_EXPORT_START',
  EXPORT_CHUNK: 'HISTORY_EXPORT_CHUNK',
  EXPORT_FINISH: 'HISTORY_EXPORT_FINISH',
  RETENTION_STATUS: 'HISTORY_RETENTION_STATUS',
  DELETE_CONFIRMED: 'HISTORY_DELETE_CONFIRMED',
  ARCHIVE_EVENTS: 'HISTORY_ARCHIVE_EVENTS',
  RETRY_PENDING: 'HISTORY_RETRY_PENDING'
});

const HISTORY_MESSAGE_TYPE_SET = new Set(Object.values(HISTORY_MESSAGE_TYPES));

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizedDomain(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : undefined;
}

function normalizeFilter(filter = {}) {
  const normalized = {
    from: finiteNumber(filter.from ?? filter.dateFrom),
    to: finiteNumber(filter.to ?? filter.dateTo),
    targetDomain: normalizedDomain(filter.targetDomain),
    promotedDomain: normalizedDomain(filter.promotedDomain),
    anchorTextPrefix: typeof filter.anchorTextPrefix === 'string' && filter.anchorTextPrefix.trim()
      ? filter.anchorTextPrefix.trim().toLowerCase()
      : undefined,
    hrefDomain: normalizedDomain(filter.hrefDomain),
    exportedBefore: finiteNumber(filter.exportedBefore)
  };
  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== undefined)
  );
}

function normalizeCursor(cursor) {
  if (!cursor || typeof cursor !== 'object') return undefined;
  if (
    finiteNumber(cursor.submittedAt) !== undefined
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
  return undefined;
}

function boundedLimit(value, fallback, maximum) {
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function filterFromMessage(message) {
  return normalizeFilter(
    message?.filter ?? message?.filters ?? message?.criteria ?? message
  );
}

function normalizeListPayload(message) {
  const cursor = normalizeCursor(message?.cursor);
  return {
    ...filterFromMessage(message),
    ...(cursor ? { cursor } : {}),
    limit: boundedLimit(message?.limit, 50, 100)
  };
}

function normalizeExportChunkPayload(message) {
  const cursor = normalizeCursor(message?.cursor);
  return {
    exportSessionId: typeof message?.exportSessionId === 'string'
      ? message.exportSessionId
      : '',
    ...(cursor ? { cursor } : {}),
    limit: boundedLimit(message?.limit, 500, 500)
  };
}

function structuredError(error) {
  const hasCode = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(error.code);
  const message = typeof error?.publicMessage === 'string'
    ? error.publicMessage
    : '评论历史请求失败。';
  return {
    code: hasCode ? error.code : 'HISTORY_REQUEST_FAILED',
    message
  };
}

function routeHistoryMessage(message, service) {
  switch (message.type) {
    case HISTORY_MESSAGE_TYPES.SUMMARY:
      return service.getSummary();
    case HISTORY_MESSAGE_TYPES.LIST:
      return service.listRecords(normalizeListPayload(message));
    case HISTORY_MESSAGE_TYPES.ANCHORS:
      return service.getAnchors(
        typeof (message.commentId ?? message.id) === 'string'
          ? (message.commentId ?? message.id)
          : ''
      );
    case HISTORY_MESSAGE_TYPES.EXPORT_START:
      return service.startExport(filterFromMessage(message));
    case HISTORY_MESSAGE_TYPES.EXPORT_CHUNK:
      return service.getExportChunk(normalizeExportChunkPayload(message));
    case HISTORY_MESSAGE_TYPES.EXPORT_FINISH:
      return service.finishExport({
        exportSessionId: typeof message.exportSessionId === 'string'
          ? message.exportSessionId
          : '',
        filenames: Array.isArray(message.filenames)
          ? message.filenames.filter((filename) => typeof filename === 'string')
          : []
      });
    case HISTORY_MESSAGE_TYPES.RETENTION_STATUS:
      return service.getRetentionStatus();
    case HISTORY_MESSAGE_TYPES.DELETE_CONFIRMED:
      return service.deleteConfirmed({
        confirmed: true,
        exportSessionId: typeof message.exportSessionId === 'string'
          ? message.exportSessionId
          : ''
      });
    case HISTORY_MESSAGE_TYPES.ARCHIVE_EVENTS:
      return service.listArchiveEvents();
    case HISTORY_MESSAGE_TYPES.RETRY_PENDING:
      return service.retryPendingWrites();
    default:
      throw new TypeError('Unknown history message type');
  }
}

export function installCommentHistoryMessageListener(chromeApi, service) {
  const listener = (message, sender, sendResponse) => {
    if (!HISTORY_MESSAGE_TYPE_SET.has(message?.type)) return false;
    if (sender?.id !== chromeApi.runtime.id) {
      sendResponse({
        ok: false,
        error: {
          code: 'FORBIDDEN_SENDER',
          message: '拒绝外部评论历史请求。'
        }
      });
      return false;
    }
    if (
      message.type === HISTORY_MESSAGE_TYPES.DELETE_CONFIRMED
      && message.confirmed !== true
    ) {
      sendResponse({
        ok: false,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: '删除评论历史需要明确确认。'
        }
      });
      return false;
    }

    Promise.resolve()
      .then(() => routeHistoryMessage(message, service))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: structuredError(error) }));
    return true;
  };

  chromeApi.runtime.onMessage.addListener(listener);
  return listener;
}
