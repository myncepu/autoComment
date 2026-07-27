const ERROR_DEFINITIONS = {
  task_timeout: {
    message: '处理超时，worker 标签页已安全关闭',
    retryPolicy: 'safe'
  },
  window_create_failed: {
    message: '无法创建 worker 标签页',
    retryPolicy: 'safe'
  },
  content_script_unavailable: {
    message: '目标页面未能启动扩展内容脚本',
    retryPolicy: 'safe'
  },
  no_comment_box: {
    message: '未检测到可用评论框',
    retryPolicy: 'safe'
  },
  submission_uncertain: {
    message: '提交确认前中断，评论可能已提交',
    retryPolicy: 'confirm'
  },
  illegal_site: {
    message: '目标网站命中非法站点规则',
    retryPolicy: 'blocked'
  }
};

export function getBatchRetryPolicy({ result, errorCode } = {}) {
  if (result === 'success' || result === 'skipped' || result === 'blocked_illegal') {
    return 'blocked';
  }
  if (result === 'manual_required') return 'confirm';
  return ERROR_DEFINITIONS[errorCode]?.retryPolicy || 'safe';
}

export function getBatchError(errorCode, details = {}) {
  const definition = ERROR_DEFINITIONS[errorCode] || {
    message: '任务执行失败',
    retryPolicy: 'safe'
  };
  const diagnostic = {};
  if (typeof details.phase === 'string') diagnostic.phase = details.phase;
  if (Number.isFinite(details.elapsedMs)) diagnostic.elapsedMs = details.elapsedMs;
  return {
    code: errorCode || 'task_failed',
    message: definition.message,
    retryPolicy: definition.retryPolicy,
    diagnostic
  };
}
