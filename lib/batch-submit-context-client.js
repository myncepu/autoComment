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
      return request({
        ...confirmation,
        type: 'BATCH_HANDLE_CONFIRM'
      });
    },
    async clear(match) {
      if (
        typeof match?.batchId !== 'string'
        || !Number.isInteger(match?.urlIndex)
        || !Number.isInteger(match?.attempt)
      ) {
        throw new Error('exact submit context identity required');
      }
      await request({
        type: 'BATCH_CLEAR_SUBMIT_CONTEXT',
        match
      });
    }
  };
})();
