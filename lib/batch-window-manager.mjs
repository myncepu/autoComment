function requireCreatedWindow(createdWindow) {
  const windowId = createdWindow?.id;
  const tabId = createdWindow?.tabs?.[0]?.id;
  if (!Number.isInteger(windowId) || !Number.isInteger(tabId)) {
    throw new Error('浏览器窗口创建成功但未返回可用标签页');
  }
  return { windowId, tabId };
}

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
    } catch {
      this.expectedWindowIds.delete(activity.windowId);
      this.removeMappings(activity);
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
