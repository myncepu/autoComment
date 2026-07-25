function requireCreatedTab(createdTab, expectedWindowId) {
  const tabId = createdTab?.id;
  const windowId = createdTab?.windowId;
  if (!Number.isInteger(tabId)) {
    throw new Error('浏览器标签页创建成功但未返回可用标签页 ID');
  }
  if (windowId !== expectedWindowId) {
    throw new Error('浏览器标签页未创建在目标浏览器窗口');
  }
  return { tabId, windowId };
}

function isMissingTabError(error) {
  const message = String(error?.message || error || '');
  return /\bNo tab with id(?::|\s)/i.test(message) ||
    /\bTab not found\b/i.test(message);
}

export class BatchTabManager {
  constructor({
    tabsApi,
    windowId,
    now = Date.now,
    onUnexpectedClose = () => {}
  }) {
    if (!Number.isInteger(windowId)) {
      throw new Error('批处理标签页管理器需要控制台所在窗口 ID');
    }
    this.tabsApi = tabsApi;
    this.windowId = windowId;
    this.now = now;
    this.onUnexpectedClose = onUnexpectedClose;
    this.byIndex = new Map();
    this.byTabId = new Map();
    this.pendingByIndex = new Map();
    this.expectedTabIds = new Set();
    this.batchId = null;
    this.handleRemoved = this.handleRemoved.bind(this);
    this.tabsApi.onRemoved.addListener(this.handleRemoved);
  }

  async create(task) {
    if (this.batchId !== null && task.batchId !== this.batchId) {
      throw new Error('标签页管理器只能处理同一批次');
    }
    if (this.byIndex.has(task.urlIndex)) {
      throw new Error('URL 索引已在标签页管理器中跟踪');
    }
    const existingPending = this.pendingByIndex.get(task.urlIndex);
    if (
      existingPending &&
      (
        !Number.isInteger(task.attempt) ||
        !Number.isInteger(existingPending.task.attempt) ||
        task.attempt <= existingPending.task.attempt
      )
    ) {
      throw new Error('URL 索引已有相同或更新的标签页创建请求');
    }
    const reservation = { task };
    this.pendingByIndex.set(task.urlIndex, reservation);
    this.batchId = task.batchId;

    let createdTab;
    try {
      createdTab = await this.tabsApi.create({
        windowId: this.windowId,
        url: task.url,
        active: false
      });
    } catch (error) {
      if (this.pendingByIndex.get(task.urlIndex) === reservation) {
        this.pendingByIndex.delete(task.urlIndex);
      }
      throw error;
    }
    let tabId;
    let windowId;
    try {
      ({ tabId, windowId } = requireCreatedTab(
        createdTab,
        this.windowId
      ));
    } catch (error) {
      if (this.pendingByIndex.get(task.urlIndex) === reservation) {
        this.pendingByIndex.delete(task.urlIndex);
      }
      if (Number.isInteger(createdTab?.id)) {
        await this.tabsApi.remove(createdTab.id).catch(() => {});
      }
      throw error;
    }
    if (this.pendingByIndex.get(task.urlIndex) !== reservation) {
      await this.tabsApi.remove(tabId).catch(() => {});
      throw new Error('标签页创建已被更新尝试替代');
    }
    this.pendingByIndex.delete(task.urlIndex);

    const activity = {
      ...task,
      tabId,
      windowId,
      startTime: this.now()
    };
    this.byIndex.set(task.urlIndex, activity);
    this.byTabId.set(tabId, activity);
    return activity;
  }

  getByIndex(index) {
    return this.byIndex.get(index) || null;
  }

  getByTabId(tabId) {
    return this.byTabId.get(tabId) || null;
  }

  removeMappings(activity) {
    if (this.byIndex.get(activity.urlIndex) === activity) {
      this.byIndex.delete(activity.urlIndex);
    }
    if (this.byTabId.get(activity.tabId) === activity) {
      this.byTabId.delete(activity.tabId);
    }
  }

  handleRemoved(tabId) {
    const activity = this.byTabId.get(tabId);
    if (!activity) return;
    this.removeMappings(activity);
    if (this.expectedTabIds.delete(tabId)) return;
    this.onUnexpectedClose(activity);
  }

  async close(activity) {
    if (!activity || !Number.isInteger(activity.tabId)) return null;
    this.expectedTabIds.add(activity.tabId);
    try {
      await this.tabsApi.remove(activity.tabId);
      this.expectedTabIds.delete(activity.tabId);
      this.removeMappings(activity);
    } catch (error) {
      this.expectedTabIds.delete(activity.tabId);
      if (isMissingTabError(error)) {
        this.removeMappings(activity);
      } else {
        throw error;
      }
    }
    return activity;
  }

  async closeByIndex(index) {
    const activity = this.getByIndex(index);
    if (!activity) return null;
    return this.close(activity);
  }

  async closeAll() {
    const activities = [...this.byIndex.values()];
    for (const activity of activities) {
      await this.close(activity);
    }
  }

  async focusByIndex(index) {
    const activity = this.getByIndex(index);
    if (!activity) return null;
    await this.tabsApi.update(activity.tabId, { active: true });
    return activity;
  }

  dispose() {
    this.tabsApi.onRemoved.removeListener(this.handleRemoved);
  }
}

function requireCreatedWindow(createdWindow) {
  const windowId = createdWindow?.id;
  const tabId = createdWindow?.tabs?.[0]?.id;
  if (!Number.isInteger(windowId) || !Number.isInteger(tabId)) {
    throw new Error('浏览器窗口创建成功但未返回可用标签页');
  }
  return { windowId, tabId };
}

function isMissingWindowError(error) {
  const message = String(error?.message || error || '');
  return /\bNo window with id(?::|\s)/i.test(message) ||
    /\bWindow not found\b/i.test(message);
}

// Temporary compatibility for the current batch.js composition. Automatic
// workers use BatchTabManager; only the legacy page may instantiate this class.
export class BatchWindowManager {
  constructor({ windowsApi, now = Date.now, onUnexpectedClose = () => {} }) {
    this.windowsApi = windowsApi;
    this.now = now;
    this.onUnexpectedClose = onUnexpectedClose;
    this.byIndex = new Map();
    this.byTabId = new Map();
    this.byWindowId = new Map();
    this.expectedWindowIds = new Set();
    this.batchId = null;
    this.handleRemoved = this.handleRemoved.bind(this);
    this.windowsApi.onRemoved.addListener(this.handleRemoved);
  }

  async create(task) {
    if (this.batchId !== null && task.batchId !== this.batchId) {
      throw new Error('窗口管理器只能处理同一批次');
    }
    if (this.byIndex.has(task.urlIndex)) {
      throw new Error('URL 索引已在窗口管理器中跟踪');
    }
    const createdWindow = await this.windowsApi.create({
      url: task.url,
      focused: false,
      type: 'normal'
    });
    let windowId;
    let tabId;
    try {
      ({ windowId, tabId } = requireCreatedWindow(createdWindow));
    } catch (error) {
      if (Number.isInteger(createdWindow?.id)) {
        await this.windowsApi.remove(createdWindow.id).catch(() => {});
      }
      throw error;
    }
    const activity = {
      ...task,
      tabId,
      windowId,
      startTime: this.now()
    };
    this.batchId = task.batchId;
    this.byIndex.set(task.urlIndex, activity);
    this.byTabId.set(tabId, activity);
    this.byWindowId.set(windowId, activity);
    return activity;
  }

  getByIndex(index) {
    return this.byIndex.get(index) || null;
  }

  getByTabId(tabId) {
    return this.byTabId.get(tabId) || null;
  }

  removeMappings(activity) {
    this.byIndex.delete(activity.urlIndex);
    this.byTabId.delete(activity.tabId);
    this.byWindowId.delete(activity.windowId);
  }

  handleRemoved(windowId) {
    const activity = this.byWindowId.get(windowId);
    if (!activity) return;
    this.removeMappings(activity);
    if (this.expectedWindowIds.delete(windowId)) return;
    this.onUnexpectedClose(activity);
  }

  async closeByIndex(index) {
    const activity = this.getByIndex(index);
    if (!activity) return null;
    this.expectedWindowIds.add(activity.windowId);
    try {
      await this.windowsApi.remove(activity.windowId);
    } catch (error) {
      this.expectedWindowIds.delete(activity.windowId);
      if (isMissingWindowError(error)) {
        this.removeMappings(activity);
      } else {
        throw error;
      }
    }
    return activity;
  }

  async closeAll() {
    const indices = [...this.byIndex.keys()];
    await Promise.all(indices.map((index) => this.closeByIndex(index)));
  }

  dispose() {
    this.windowsApi.onRemoved.removeListener(this.handleRemoved);
  }
}
