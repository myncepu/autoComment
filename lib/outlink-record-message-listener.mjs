export const OUTLINK_MESSAGE_TYPES = Object.freeze({
  OPEN_PAGE: 'OUTLINKS_OPEN_PAGE',
  SAVE: 'OUTLINKS_SAVE',
  LIST: 'OUTLINKS_LIST',
  SUMMARY: 'OUTLINKS_SUMMARY',
  SUCCESS_STATS: 'OUTLINKS_SUCCESS_STATS',
  EXPORT: 'OUTLINKS_EXPORT',
  DELETE: 'OUTLINKS_DELETE',
  CLEAR: 'OUTLINKS_CLEAR'
});

export const OUTLINK_RECORDS_PAGE = 'records.html';

const TYPE_SET = new Set(Object.values(OUTLINK_MESSAGE_TYPES));

function structuredError(error) {
  return {
    code: 'OUTLINK_REQUEST_FAILED',
    message: typeof error?.message === 'string'
      ? error.message
      : '外链数据请求失败。'
  };
}

async function route(message, repository, successStatsProvider) {
  switch (message.type) {
    case OUTLINK_MESSAGE_TYPES.SAVE:
      return repository.saveExport(message.payload);
    case OUTLINK_MESSAGE_TYPES.LIST:
      return repository.list({
        filter: message.filter,
        offset: message.offset,
        limit: message.limit,
        successStats: await successStatsProvider()
      });
    case OUTLINK_MESSAGE_TYPES.SUCCESS_STATS:
      return successStatsProvider();
    case OUTLINK_MESSAGE_TYPES.SUMMARY:
      return repository.summary();
    case OUTLINK_MESSAGE_TYPES.EXPORT:
      return repository.exportRecords(
        message.filter,
        await successStatsProvider()
      );
    case OUTLINK_MESSAGE_TYPES.DELETE:
      return repository.deleteRecords(message.ids);
    case OUTLINK_MESSAGE_TYPES.CLEAR:
      return repository.clear();
    default:
      throw new TypeError('Unknown outlink message type');
  }
}

async function openOutlinkPage(chromeApi) {
  await chromeApi.tabs.create({
    url: chromeApi.runtime.getURL(OUTLINK_RECORDS_PAGE)
  });
  return { opened: true };
}

export function installOutlinkRecordMessageListener(
  chromeApi,
  repositoryPromise,
  { successStatsProvider = async () => [] } = {}
) {
  const listener = (message, sender, sendResponse) => {
    if (!TYPE_SET.has(message?.type)) return false;
    if (sender?.id !== chromeApi.runtime.id) {
      sendResponse({
        ok: false,
        error: { code: 'FORBIDDEN_SENDER', message: '拒绝外部外链数据请求。' }
      });
      return false;
    }
    const operation = message.type === OUTLINK_MESSAGE_TYPES.OPEN_PAGE
      ? openOutlinkPage(chromeApi)
      : Promise.resolve(repositoryPromise)
          .then((repository) => route(
            message,
            repository,
            successStatsProvider
          ));
    Promise.resolve(operation)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: structuredError(error) }));
    return true;
  };
  chromeApi.runtime.onMessage.addListener(listener);
  return listener;
}
