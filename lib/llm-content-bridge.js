(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.AutoCommentLlmBridge = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBridge() {
  function buildPageUserPrompt({ websiteUrl, title, description, bodyText }) {
    const excerpt = String(bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    return [
      '下面是当前网站的内容，请根据系统提示词生成一份推广评论：',
      `【网站标题】${title || '(无标题)'}`,
      `【网站 URL】${websiteUrl || '(无URL)'}`,
      description ? `【网站描述】${description}` : '',
      '【页面正文节选】',
      excerpt || '(当前页面正文内容为空或无法提取)'
    ].filter(Boolean).join('\n');
  }

  async function generate(runtime, payload) {
    const response = await runtime.sendMessage({ type: 'LLM_GENERATE_COPY', payload });
    if (!response?.success) {
      const error = new Error(response?.error?.message || '模型生成失败。');
      error.code = response?.error?.code || 'UNKNOWN_ERROR';
      throw error;
    }

    const text = typeof response.text === 'string' ? response.text.trim() : '';
    if (!text) {
      const error = new Error('模型返回了空内容。');
      error.code = 'INVALID_RESPONSE';
      throw error;
    }
    return text;
  }

  return { buildPageUserPrompt, generate };
});
