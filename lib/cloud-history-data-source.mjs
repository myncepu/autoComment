const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_DAYS = 90;
const QUERY_FIELDS = Object.freeze([
  'from',
  'to',
  'targetDomain',
  'promotedDomain',
  'anchorTextPrefix',
  'hrefDomain',
  'profileId',
  'promotionSiteId',
  'limit'
]);
const CLOUD_SEARCH_FIELDS = Object.freeze([
  'targetDomain',
  'promotedDomain',
  'anchorTextPrefix',
  'hrefDomain',
  'profileId',
  'promotionSiteId'
]);

export const CLOUD_HISTORY_OFFLINE_ERROR = Object.freeze({
  code: 'CLOUD_HISTORY_UNAVAILABLE_OFFLINE',
  message: '当前离线，无法读取所需的云端评论历史。',
  retryable: true
});

class CloudHistoryDataSourceError extends Error {
  constructor({ code, message, retryable = false }) {
    super(message);
    this.name = 'CloudHistoryDataSourceError';
    this.code = code;
    this.retryable = Boolean(retryable);
  }
}

function dataSourceError(code, message, retryable = false) {
  return new CloudHistoryDataSourceError({ code, message, retryable });
}

function queryFilter(filter) {
  return Object.fromEntries(
    QUERY_FIELDS
      .filter((field) => filter?.[field] !== undefined)
      .map((field) => [field, filter[field]])
  );
}

function filterSignature(filter) {
  return JSON.stringify({
    syncEnabled: filter?.syncEnabled === true,
    query: queryFilter(filter)
  });
}

function hasCloudSearch(filter) {
  return CLOUD_SEARCH_FIELDS.some((field) => (
    typeof filter?.[field] === 'string' && filter[field].length > 0
  ));
}

function initialMode(filter, cutoff) {
  if (filter?.syncEnabled !== true) return 'local_disabled';
  if (hasCloudSearch(filter)) return 'cloud';
  if (filter?.from !== undefined && filter.from < cutoff) return 'cloud';
  if (filter?.from === undefined && filter?.to !== undefined) return 'cloud';
  if (filter?.from !== undefined) return 'local_recent';
  return 'hybrid';
}

function localCursor(value) {
  if (
    value
    && typeof value === 'object'
    && Number.isFinite(value.submittedAt)
    && typeof value.id === 'string'
  ) {
    return { submittedAt: value.submittedAt, id: value.id };
  }
  if (
    value
    && typeof value === 'object'
    && typeof value.anchorKey === 'string'
    && typeof value.anchorPrimaryKey === 'string'
  ) {
    return {
      anchorKey: value.anchorKey,
      anchorPrimaryKey: value.anchorPrimaryKey
    };
  }
  return null;
}

function cloudCursor(value) {
  return (
    value
    && typeof value === 'object'
    && Number.isFinite(value.submittedAt)
    && typeof value.id === 'string'
    && value.id.length > 0
  ) ? { submittedAt: value.submittedAt, id: value.id } : null;
}

function publicError(error) {
  if (error instanceof CloudHistoryDataSourceError) return error;
  const supplied = error?.error;
  if (
    supplied
    && typeof supplied.code === 'string'
    && typeof supplied.message === 'string'
  ) {
    return dataSourceError(
      supplied.code,
      supplied.message,
      supplied.retryable === true
    );
  }
  return dataSourceError(
    'HISTORY_REQUEST_FAILED',
    '评论历史请求失败，请稍后重试。',
    true
  );
}

async function responseData(sendMessage, message) {
  let response;
  try {
    response = await sendMessage(message);
  } catch (error) {
    throw publicError(error);
  }
  if (response?.ok === true && Object.hasOwn(response, 'data')) {
    return response.data;
  }
  if (response?.ok === false) throw publicError(response);
  throw dataSourceError(
    'INVALID_HISTORY_RESPONSE',
    '评论历史服务返回了无效响应。',
    true
  );
}

function tagRecords(records, storageSource) {
  if (!Array.isArray(records)) return [];
  if (storageSource === 'cloud') {
    return records.map((record) => ({
      comment: record?.comment ?? {},
      anchors: Array.isArray(record?.anchors) ? record.anchors : [],
      storageSource
    }));
  }
  return records.map((comment) => ({
    comment,
    anchors: null,
    storageSource
  }));
}

export function createCloudHistoryDataSource({
  sendMessage,
  now = Date.now
} = {}) {
  if (typeof sendMessage !== 'function') {
    throw new TypeError('sendMessage is required');
  }
  const issuedStates = new WeakMap();

  function issueState(metadata) {
    const stableLocalCursor = metadata.localCursor
      ? Object.freeze({ ...metadata.localCursor })
      : null;
    const stableCloudCursor = metadata.cloudCursor
      ? Object.freeze({ ...metadata.cloudCursor })
      : null;
    const stableMetadata = Object.freeze({
      ...metadata,
      localCursor: stableLocalCursor,
      cloudCursor: stableCloudCursor
    });
    const state = Object.freeze({
      phase: metadata.phase,
      localCursor: stableLocalCursor,
      cloudCursor: stableCloudCursor,
      cutoff: metadata.cutoff
    });
    issuedStates.set(state, stableMetadata);
    return state;
  }

  function readState(cursorState, filter) {
    if (cursorState == null) return null;
    const metadata = issuedStates.get(cursorState);
    if (
      !metadata
      || metadata.signature !== filterSignature(filter)
    ) {
      throw dataSourceError(
        'INVALID_HISTORY_CURSOR',
        '评论历史分页状态无效，请重新应用筛选条件。'
      );
    }
    return metadata;
  }

  async function list(filter = {}, cursorState = null) {
    const existing = readState(cursorState, filter);
    const cutoff = existing?.cutoff ?? (now() - CACHE_DAYS * DAY_MS);
    const mode = existing?.mode ?? initialMode(filter, cutoff);
    const phase = existing?.phase ?? (mode === 'cloud' ? 'cloud' : 'local');
    const signature = existing?.signature ?? filterSignature(filter);
    const baseQuery = queryFilter(filter);

    if (phase === 'cloud') {
      if (filter.online === false) {
        throw dataSourceError(
          CLOUD_HISTORY_OFFLINE_ERROR.code,
          CLOUD_HISTORY_OFFLINE_ERROR.message,
          CLOUD_HISTORY_OFFLINE_ERROR.retryable
        );
      }
      const cursor = existing?.cloudCursor ?? null;
      const query = {
        ...baseQuery,
        ...(mode === 'hybrid' ? { to: cutoff - 1 } : {}),
        ...(cursor ? {
          cursorSubmittedAt: cursor.submittedAt,
          cursorId: cursor.id
        } : {})
      };
      const data = await responseData(sendMessage, {
        type: 'CLOUD_HISTORY_LIST',
        query
      });
      const next = cloudCursor(data?.nextCursor);
      return {
        ...data,
        records: tagRecords(data?.records, 'cloud'),
        nextCursor: next ? issueState({
          phase: 'cloud',
          localCursor: existing?.localCursor ?? null,
          cloudCursor: next,
          cutoff,
          mode,
          signature
        }) : null
      };
    }

    const cursor = existing?.localCursor ?? null;
    const query = {
      ...baseQuery,
      ...(mode === 'local_disabled' ? {} : {
        from: Math.max(baseQuery.from ?? cutoff, cutoff)
      }),
      ...(cursor ? { cursor } : {})
    };
    const data = await responseData(sendMessage, {
      type: 'HISTORY_LIST',
      ...query
    });
    const next = localCursor(data?.nextCursor);
    let nextCursor = null;
    if (next) {
      nextCursor = issueState({
        phase: 'local',
        localCursor: next,
        cloudCursor: null,
        cutoff,
        mode,
        signature
      });
    } else if (mode === 'hybrid') {
      nextCursor = issueState({
        phase: 'cloud',
        localCursor: null,
        cloudCursor: null,
        cutoff,
        mode,
        signature
      });
    }
    return {
      ...data,
      records: tagRecords(data?.records, 'local'),
      nextCursor
    };
  }

  return Object.freeze({
    list,
    status() {
      return responseData(sendMessage, { type: 'CLOUD_SYNC_STATUS' });
    },
    deleteEverywhere(recordId) {
      return responseData(sendMessage, {
        type: 'CLOUD_HISTORY_DELETE',
        recordId
      });
    }
  });
}
