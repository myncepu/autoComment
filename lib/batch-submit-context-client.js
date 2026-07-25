(() => {
  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      throw new Error(response?.error || '批处理提交上下文操作失败');
    }
    return response;
  }

  window.AutoCommentBatchSubmitContext = {
    async save(context) {
      await request({ type: 'BATCH_SAVE_SUBMIT_CONTEXT', context });
    },
    async restore() {
      const response = await request({ type: 'BATCH_GET_SUBMIT_CONTEXT' });
      return response.context || null;
    },
    async confirm(confirmation) {
      const response = await request({
        ...confirmation,
        type: 'BATCH_HANDLE_CONFIRM'
      });
      await this.clear({
        batchId: confirmation.batchId,
        urlIndex: confirmation.urlIndex,
        ...(confirmation.history?.historyRevision
          ? { historyRevision: confirmation.history.historyRevision }
          : {})
      });
      return response;
    },
    async clear(match) {
      await request({
        type: 'BATCH_CLEAR_SUBMIT_CONTEXT',
        ...(match ? { match } : {})
      });
    }
  };
})();
