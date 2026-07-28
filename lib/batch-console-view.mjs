const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

const STATUS_LABELS = {
  empty: '尚无批次',
  running: '运行中',
  pausing: '正在安全暂停',
  paused_recovery: '已暂停，可恢复',
  completed: '已完成',
  terminated: '已永久停止',
  failed: '运行异常'
};

const ROW_STATUS_LABELS = {
  queued: '排队',
  running: '运行中',
  success: '成功/已存在',
  failed: '失败',
  manual: '需人工'
};

const PHASE_LABELS = {
  opening: '正在创建 worker 标签页',
  loading: '正在加载目标页面',
  detecting: '正在识别评论表单',
  generating: '正在生成文案',
  filling: '正在填写表单',
  submitting: '正在准备或执行提交',
  confirming: '正在等待提交确认',
  closing: '正在安全关闭 worker 标签页'
};

const SUMMARY_FIELDS = [
  ['total', '总目标'],
  ['queued', '排队'],
  ['running', '运行'],
  ['success', '成功/已存在'],
  ['failed', '失败'],
  ['manual', '需人工']
];

const bannerFingerprints = new WeakMap();
const countFingerprints = new WeakMap();

function text(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function integer(value, fallback = 0) {
  return Number.isInteger(value) ? value : fallback;
}

function appendText(documentRef, parent, tagName, value, attributes = {}) {
  const element = documentRef.createElement(tagName);
  element.textContent = text(value);
  for (const [name, attributeValue] of Object.entries(attributes)) {
    if (attributeValue === undefined || attributeValue === null) continue;
    element.setAttribute(name, String(attributeValue));
  }
  parent.appendChild(element);
  return element;
}

function button(documentRef, parent, label, action, options = {}) {
  const element = appendText(documentRef, parent, 'button', label, {
    type: 'button',
    'data-action': action,
    'data-url-index': options.urlIndex,
    'data-attempt': options.attempt,
    'aria-label': options.ariaLabel
  });
  element.className = options.className || 'batch-console__button';
  element.disabled = options.disabled === true;
  return element;
}

function formatElapsed(elapsedMs) {
  if (!Number.isFinite(elapsedMs)) return '—';
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes} 分钟` : `${minutes} 分 ${remainder} 秒`;
}

function formatTimestamp(timestamp) {
  if (!Number.isFinite(timestamp)) return '尚未保存';
  try {
    return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
  } catch (_) {
    return '已保存';
  }
}

function phaseLabel(phase) {
  return PHASE_LABELS[phase] || text(phase, '等待队列');
}

function rowStatusLabel(row) {
  return ROW_STATUS_LABELS[row?.status] || text(row?.status, '未知');
}

function rowErrorMessage(row) {
  return text(row?.errorMessage || row?.error?.message);
}

function rowSummary(row) {
  return rowErrorMessage(row) || phaseLabel(row?.phase);
}

function rowLabel(row) {
  return [
    `序号 ${integer(row?.urlIndex)}`,
    rowStatusLabel(row),
    text(row?.domain),
    formatElapsed(row?.elapsedMs),
    rowSummary(row)
  ].filter(Boolean).join('，');
}

function rowIdentity(row) {
  return {
    urlIndex: integer(row?.urlIndex, -1),
    attempt: Math.max(1, integer(row?.attempt, 1))
  };
}

function commandTask(row, snapshot) {
  return {
    batchId: text(snapshot?.batchId),
    urlIndex: integer(row?.urlIndex, -1),
    attempt: Math.max(1, integer(row?.attempt, 1)),
    url: text(row?.url),
    domain: text(row?.domain),
    result: row?.result === null || row?.result === undefined
      ? null
      : text(row.result),
    errorCode: text(row?.error?.code) || null,
    retryPolicy: text(row?.retryPolicy, 'safe')
  };
}

function isRowAction(row, action) {
  const actions = Array.isArray(row?.actions) ? row.actions : [];
  if (action === 'focus-tab') {
    return actions.includes('focus-tab') || actions.includes('focus-window');
  }
  if (action === 'manual') {
    return actions.includes('manual') ||
      row?.status === 'manual' ||
      row?.result === 'no_comment_box';
  }
  return actions.includes(action);
}

function slotCapacity(snapshot) {
  if (Number.isInteger(snapshot?.slotCapacity)) {
    return Math.max(0, snapshot.slotCapacity);
  }
  if (Number.isInteger(snapshot?.concurrency)) {
    return Math.max(0, snapshot.concurrency);
  }
  const limits = text(snapshot?.assignment?.limitsLabel);
  const match = limits.match(/并发\s*(\d+)/);
  if (match) return Number(match[1]);
  return Array.isArray(snapshot?.slots) ? snapshot.slots.length : 0;
}

function normalizedFilters(snapshot) {
  const filters = snapshot?.filters || {};
  return {
    status: text(filters.status, 'all') || 'all',
    domain: text(filters.domain, 'all') || 'all',
    profile: text(filters.profile, 'all') || 'all',
    promotionSite: text(filters.promotionSite, 'all') || 'all',
    timeRange: text(filters.timeRange, 'all') || 'all',
    keyword: text(filters.keyword)
  };
}

function visibleRows(snapshot) {
  if (Array.isArray(snapshot?.filteredRows)) return snapshot.filteredRows;
  return Array.isArray(snapshot?.rows) ? snapshot.rows : [];
}

function allRows(snapshot) {
  return Array.isArray(snapshot?.rows) ? snapshot.rows : [];
}

function commandState(snapshot) {
  const source = snapshot?.command || {};
  return {
    inFlight: text(source.inFlight) || null,
    canPause: source.canPause === true,
    canResume: source.canResume === true,
    canRetryPersistence: source.canRetryPersistence === true,
    canStop: source.canStop === true,
    canExport: source.canExport === true,
    canCreate: source.canCreate === true,
    resultMessage: text(source.resultMessage)
  };
}

const COMMAND_LABELS = Object.freeze({
  start: '启动批次',
  pause: '暂停批次',
  resume: '继续批次',
  stop: '停止批次',
  retry: '重试任务',
  'retry-persistence': '保存恢复检查点',
  offline: '处理离线状态',
  manual: '更新人工处理状态'
});

function commandLabel(command) {
  return COMMAND_LABELS[text(command)] || '批次操作';
}

function setTextIfChanged(element, value) {
  const next = text(value);
  if (element && element.textContent !== next) element.textContent = next;
}

function renderCommandActions(documentRef, parent, snapshot) {
  const command = commandState(snapshot);
  parent.textContent = '';
  const busy = Boolean(command.inFlight);
  if (snapshot?.persistencePending) {
    button(documentRef, parent, '重试保存检查点', 'retry-persistence', {
      className: 'batch-console__button batch-console__button--primary',
      disabled: busy || !command.canRetryPersistence
    });
  } else if (command.canResume || snapshot?.status === 'paused_recovery') {
    button(documentRef, parent, '继续处理', 'resume', {
      className: 'batch-console__button batch-console__button--primary',
      disabled: busy || !command.canResume
    });
  } else {
    button(documentRef, parent, '暂停', 'pause', {
      disabled: busy || !command.canPause
    });
  }
  button(documentRef, parent, '停止批次…', 'stop', {
    className: 'batch-console__button batch-console__button--danger-entry',
    disabled: busy || !command.canStop
  });
  button(documentRef, parent, '导出当前结果', 'export', {
    disabled: busy || !command.canExport
  });
  button(documentRef, parent, '新建批次', 'new-batch', {
    className: 'batch-console__button batch-console__button--primary',
    disabled: busy || !command.canCreate
  });
}

function renderCommandBar(documentRef, snapshot) {
  const command = commandState(snapshot);
  const bar = documentRef.createElement('section');
  bar.className = 'batch-console__command-bar';
  bar.dataset.commandBar = '';
  bar.dataset.sticky = 'true';
  bar.setAttribute('aria-label', '批次命令');
  bar.setAttribute('aria-busy', String(Boolean(command.inFlight)));

  const identity = documentRef.createElement('div');
  identity.className = 'batch-console__identity';
  appendText(
    documentRef,
    identity,
    'p',
    text(snapshot?.batchName, snapshot?.batchId ? '当前批次' : '批次控制台'),
    { 'data-batch-name': '' }
  );
  appendText(
    documentRef,
    identity,
    'p',
    STATUS_LABELS[snapshot?.status] || text(snapshot?.status, '状态未知'),
    {
      'data-batch-status': '',
      'aria-live': 'polite'
    }
  );
  bar.appendChild(identity);

  const actions = documentRef.createElement('div');
  actions.className = 'batch-console__command-actions';
  renderCommandActions(documentRef, actions, snapshot);
  bar.appendChild(actions);

  appendText(
    documentRef,
    bar,
    'p',
    command.inFlight
      ? `正在执行：${commandLabel(command.inFlight)}`
      : command.resultMessage,
    {
      class: 'batch-console__command-result',
      role: 'status',
      'aria-live': 'polite',
      'data-command-result': ''
    }
  );
  return bar;
}

function updateCommandBar(documentRef, bar, snapshot) {
  const command = commandState(snapshot);
  bar.setAttribute('aria-busy', String(Boolean(command.inFlight)));
  setTextIfChanged(
    bar.querySelector('[data-batch-name]'),
    text(snapshot?.batchName, snapshot?.batchId ? '当前批次' : '批次控制台')
  );
  setTextIfChanged(
    bar.querySelector('[data-batch-status]'),
    STATUS_LABELS[snapshot?.status] || text(snapshot?.status, '状态未知')
  );
  renderCommandActions(
    documentRef,
    bar.querySelector('.batch-console__command-actions'),
    snapshot
  );
  setTextIfChanged(
    bar.querySelector('[data-command-result]'),
    command.inFlight
      ? `正在执行：${commandLabel(command.inFlight)}`
      : command.resultMessage
  );
}

function bannerFingerprint(snapshot) {
  return JSON.stringify((Array.isArray(snapshot?.banners) ? snapshot.banners : [])
    .map((banner) => ({
      kind: text(banner?.kind, 'notice'),
      title: text(banner?.title, '运行通知'),
      message: text(banner?.message),
      diagnosticCode: text(banner?.diagnosticCode)
    })));
}

function updateBanners(documentRef, region, snapshot) {
  const fingerprint = bannerFingerprint(snapshot);
  if (bannerFingerprints.get(region) === fingerprint) return;
  bannerFingerprints.set(region, fingerprint);
  region.textContent = '';
  const banners = Array.isArray(snapshot?.banners) ? snapshot.banners : [];
  for (const banner of banners) {
    const article = documentRef.createElement('article');
    const kind = text(banner?.kind, 'notice').replace(/[^a-z0-9_-]/gi, '');
    article.className = `batch-console__banner batch-console__banner--${kind || 'notice'}`;
    article.dataset.bannerKind = kind || 'notice';
    if (kind === 'error') {
      article.setAttribute('role', 'alert');
      article.setAttribute('aria-live', 'assertive');
      article.setAttribute('tabindex', '-1');
      article.dataset.runtimeError = '';
      if (banner?.diagnosticCode) {
        article.dataset.runtimeErrorCode = text(banner.diagnosticCode);
      }
    }
    appendText(documentRef, article, 'h2', banner?.title || '运行通知');
    appendText(documentRef, article, 'p', banner?.message);
    region.appendChild(article);
  }
}

function renderBanners(documentRef, snapshot) {
  const region = documentRef.createElement('section');
  region.className = 'batch-console__banners';
  region.dataset.consoleBanners = '';
  region.setAttribute('aria-label', '运行通知');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  updateBanners(documentRef, region, snapshot);
  return region;
}

function countFingerprint(snapshot) {
  const counts = snapshot?.counts || {};
  return SUMMARY_FIELDS.map(([key]) => integer(counts[key])).join('|');
}

function updateSummary(section, snapshot) {
  const counts = snapshot?.counts || {};
  for (const [key] of SUMMARY_FIELDS) {
    const item = section.querySelector(`[data-summary-count="${key}"]`);
    setTextIfChanged(item?.querySelector('strong'), integer(counts[key]));
  }
  const announcer = section.querySelector('[data-count-announcer]');
  const fingerprint = countFingerprint(snapshot);
  if (countFingerprints.get(announcer) === fingerprint) return;
  countFingerprints.set(announcer, fingerprint);
  setTextIfChanged(
    announcer,
    SUMMARY_FIELDS
      .map(([key, label]) => `${label} ${integer(counts[key])}`)
      .join('，')
  );
}

function renderSummary(documentRef, snapshot) {
  const section = documentRef.createElement('section');
  section.className = 'batch-console__summary';
  section.setAttribute('aria-label', '批次摘要');
  const counts = snapshot?.counts || {};
  for (const [key, label] of SUMMARY_FIELDS) {
    const item = documentRef.createElement('article');
    item.className = 'batch-console__metric';
    item.dataset.summaryCount = key;
    appendText(documentRef, item, 'span', label);
    appendText(documentRef, item, 'strong', integer(counts[key]));
    section.appendChild(item);
  }
  appendText(documentRef, section, 'p', '', {
    class: 'sr-only',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
    'data-count-announcer': ''
  });
  updateSummary(section, snapshot);
  return section;
}

function renderAssignment(documentRef, snapshot) {
  const section = documentRef.createElement('section');
  section.className = 'batch-console__panel';
  section.dataset.assignmentSummary = '';
  section.setAttribute('aria-labelledby', 'batch-console-assignment');
  appendText(
    documentRef,
    section,
    'h2',
    '当前批次分配',
    { id: 'batch-console-assignment' }
  );
  const list = documentRef.createElement('dl');
  const entries = [
    ['身份', snapshot?.assignment?.identityLabel || '未分配'],
    ['推广网站', snapshot?.assignment?.promotionSiteLabel || '未分配'],
    ['自动化', snapshot?.assignment?.automationLabel || '未设置'],
    ['限制', snapshot?.assignment?.limitsLabel || '未设置']
  ];
  for (const [term, description] of entries) {
    appendText(documentRef, list, 'dt', term);
    appendText(documentRef, list, 'dd', description);
  }
  section.appendChild(list);
  return section;
}

function renderSlots(documentRef, snapshot) {
  const section = documentRef.createElement('section');
  section.className = 'batch-console__panel';
  section.dataset.workerSlots = '';
  section.setAttribute('aria-labelledby', 'batch-console-slots');
  appendText(
    documentRef,
    section,
    'h2',
    'worker 标签页槽位',
    { id: 'batch-console-slots' }
  );
  const slots = Array.isArray(snapshot?.slots) ? snapshot.slots : [];
  const capacity = slotCapacity(snapshot);
  const list = documentRef.createElement('ol');
  list.className = 'batch-console__slots';
  for (let index = 0; index < capacity; index += 1) {
    const source = slots[index] || null;
    const item = documentRef.createElement('li');
    item.className = 'batch-console__slot';
    item.dataset.workerSlot = String(index + 1);
    item.dataset.slotState = source ? 'active' : 'idle';
    appendText(documentRef, item, 'strong', `槽位 ${index + 1}`);
    if (!source) {
      appendText(documentRef, item, 'span', '等待队列');
    } else {
      appendText(documentRef, item, 'span', source.domain || source.url || '目标页面');
      appendText(
        documentRef,
        item,
        'span',
        `${source.profileLabel || '未分配'} × ${source.promotionSiteLabel || '未分配'}`
      );
      appendText(documentRef, item, 'span', phaseLabel(source.phase));
      appendText(documentRef, item, 'span', formatElapsed(source.elapsedMs));
      appendText(
        documentRef,
        item,
        'span',
        source.tabLabel || (
          Number.isInteger(source.tabId) ? `标签页 ${source.tabId}` : 'worker 标签页'
        )
      );
    }
    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
}

function renderHealth(documentRef, snapshot) {
  const section = documentRef.createElement('section');
  section.className = 'batch-console__panel';
  section.dataset.runtimeHealth = '';
  section.setAttribute('aria-labelledby', 'batch-console-health');
  appendText(
    documentRef,
    section,
    'h2',
    '运行保障',
    { id: 'batch-console-health' }
  );
  const list = documentRef.createElement('dl');
  appendText(documentRef, list, 'dt', '检查点');
  appendText(
    documentRef,
    list,
    'dd',
    snapshot?.persistencePending
      ? '等待持久化'
      : formatTimestamp(snapshot?.lastCheckpointSavedAt)
  );
  appendText(documentRef, list, 'dt', '系统保活');
  appendText(documentRef, list, 'dd', snapshot?.keepAlive ? '已启用' : '未启用');
  appendText(documentRef, list, 'dt', '网络');
  appendText(documentRef, list, 'dd', snapshot?.online === false ? '离线' : '在线');
  section.appendChild(list);
  return section;
}

function renderOverview(documentRef, snapshot) {
  const overview = documentRef.createElement('section');
  overview.className = 'batch-console__overview';
  overview.dataset.consoleOverview = '';
  overview.setAttribute('aria-label', '批次运行概览');
  const summaries = documentRef.createElement('div');
  summaries.className = 'batch-console__overview-summaries';
  summaries.append(
    renderAssignment(documentRef, snapshot),
    renderHealth(documentRef, snapshot)
  );
  overview.append(summaries, renderSlots(documentRef, snapshot));
  return overview;
}

function selectField(documentRef, parent, {
  label,
  name,
  value,
  options
}) {
  const id = `batch-console-${name}`;
  const wrapper = documentRef.createElement('div');
  wrapper.className = 'batch-console__filter';
  appendText(documentRef, wrapper, 'label', label, { for: id });
  const select = documentRef.createElement('select');
  select.id = id;
  select.name = name;
  for (const [optionValue, optionLabel] of options) {
    const option = appendText(documentRef, select, 'option', optionLabel, {
      value: optionValue
    });
    option.selected = optionValue === value;
  }
  wrapper.appendChild(select);
  parent.appendChild(wrapper);
  return select;
}

function updateSelectOptions(documentRef, select, value, options) {
  select.textContent = '';
  for (const [optionValue, optionLabel] of options) {
    const option = appendText(documentRef, select, 'option', optionLabel, {
      value: optionValue
    });
    option.selected = optionValue === value;
  }
  select.value = value;
}

function renderToolbar(documentRef, snapshot, existingToolbar = null) {
  const filters = normalizedFilters(snapshot);
  const toolbar = existingToolbar || documentRef.createElement('div');
  if (!existingToolbar) {
    toolbar.className = 'batch-console__toolbar';
    toolbar.setAttribute('role', 'search');
    toolbar.setAttribute('aria-label', '筛选目标队列');

    selectField(documentRef, toolbar, {
      label: '状态',
      name: 'queueStatus',
      value: filters.status,
      options: []
    });
    selectField(documentRef, toolbar, {
      label: '域名',
      name: 'queueDomain',
      value: filters.domain,
      options: []
    });
    selectField(documentRef, toolbar, {
      label: '身份',
      name: 'queueProfile',
      value: filters.profile,
      options: []
    });
    selectField(documentRef, toolbar, {
      label: '推广网站',
      name: 'queuePromotionSite',
      value: filters.promotionSite,
      options: []
    });
    selectField(documentRef, toolbar, {
      label: '耗时范围',
      name: 'queueTimeRange',
      value: filters.timeRange,
      options: []
    });

    const search = documentRef.createElement('div');
    search.className = 'batch-console__filter batch-console__filter--search';
    const searchId = 'batch-console-queueKeyword';
    appendText(documentRef, search, 'label', '搜索 URL、AI 内容或错误', {
      for: searchId
    });
    const input = documentRef.createElement('input');
    input.id = searchId;
    input.name = 'queueKeyword';
    input.type = 'search';
    input.placeholder = '输入关键词';
    search.appendChild(input);
    toolbar.appendChild(search);
  }

  updateSelectOptions(
    documentRef,
    toolbar.querySelector('[name="queueStatus"]'),
    filters.status,
    [
      ['all', '全部状态'],
      ['queued', '排队'],
      ['running', '运行中'],
      ['success', '成功/已存在'],
      ['failed', '失败'],
      ['manual', '需人工']
    ]
  );
  const profiles = new Map(allRows(snapshot)
    .filter((row) => text(row?.profileId))
    .map((row) => [text(row.profileId), text(row.profileLabel) || text(row.profileId)]));
  updateSelectOptions(
    documentRef,
    toolbar.querySelector('[name="queueProfile"]'),
    filters.profile,
    [['all', '全部身份'], ...[...profiles.entries()]
      .sort((left, right) => left[1].localeCompare(right[1]))]
  );
  const promotionSites = new Map(allRows(snapshot)
    .filter((row) => text(row?.promotionSiteId))
    .map((row) => [
      text(row.promotionSiteId),
      text(row.promotionSiteLabel) || text(row.promotionSiteId)
    ]));
  updateSelectOptions(
    documentRef,
    toolbar.querySelector('[name="queuePromotionSite"]'),
    filters.promotionSite,
    [['all', '全部推广网站'], ...[...promotionSites.entries()]
      .sort((left, right) => left[1].localeCompare(right[1]))]
  );

  const domains = [...new Set(allRows(snapshot)
    .map((row) => text(row?.domain))
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  updateSelectOptions(
    documentRef,
    toolbar.querySelector('[name="queueDomain"]'),
    filters.domain,
    [['all', '全部域名'], ...domains.map((domain) => [domain, domain])]
  );
  updateSelectOptions(
    documentRef,
    toolbar.querySelector('[name="queueTimeRange"]'),
    filters.timeRange,
    [
      ['all', '全部时间'],
      ['last-hour', '最近一小时'],
      ['last-day', '最近一天'],
      ['last-week', '最近一周']
    ]
  );

  const input = toolbar.querySelector('[name="queueKeyword"]');
  if (input.value !== filters.keyword) input.value = filters.keyword;
  return toolbar;
}

function slotForRow(snapshot, row) {
  return (Array.isArray(snapshot?.slots) ? snapshot.slots : []).find((slot) => (
    slot?.urlIndex === row?.urlIndex && slot?.attempt === row?.attempt
  ));
}

function tabLabel(snapshot, row) {
  const slot = slotForRow(snapshot, row);
  if (slot?.tabLabel) return text(slot.tabLabel);
  if (Number.isInteger(slot?.tabId)) return `标签页 ${slot.tabId}`;
  return '—';
}

function renderRowActions(documentRef, parent, row, busy = false) {
  const identity = rowIdentity(row);
  const group = documentRef.createElement('div');
  group.className = 'batch-console__row-actions';
  button(documentRef, group, '详情', 'details', identity);
  if (isRowAction(row, 'focus-tab')) {
    button(documentRef, group, '聚焦标签页', 'focus-tab', {
      ...identity,
      disabled: busy
    });
  }
  if (isRowAction(row, 'retry') && row?.retryPolicy !== 'blocked') {
    button(documentRef, group, '重试', 'retry', {
      ...identity,
      disabled: busy
    });
  }
  if (isRowAction(row, 'manual')) {
    button(documentRef, group, '人工处理', 'manual', {
      ...identity,
      disabled: busy
    });
    button(documentRef, group, '标记已处理', 'manual-resolved', {
      ...identity,
      disabled: busy
    });
    button(documentRef, group, '仍未解决', 'manual-unresolved', {
      ...identity,
      disabled: busy
    });
  }
  parent.appendChild(group);
}

function renderTable(documentRef, snapshot, rows) {
  const wrapper = documentRef.createElement('div');
  wrapper.className = 'batch-console__table-wrap';
  wrapper.tabIndex = 0;
  wrapper.setAttribute('aria-label', '完整目标队列，可横向滚动');
  const table = documentRef.createElement('table');
  table.className = 'batch-console__table';
  appendText(documentRef, table, 'caption', '批次目标完整生命周期', {
    class: 'sr-only'
  });
  const head = documentRef.createElement('thead');
  const headRow = documentRef.createElement('tr');
  for (const label of [
    '序号',
    '目标 URL',
    '身份',
    '推广网站',
    '评论文本',
    '锚文本',
    '推广网址',
    '状态',
    '耗时',
    '阶段或错误',
    'worker 标签页',
    '操作'
  ]) {
    appendText(documentRef, headRow, 'th', label, { scope: 'col' });
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = documentRef.createElement('tbody');
  for (const row of rows) {
    const tr = documentRef.createElement('tr');
    tr.dataset.taskRow = String(integer(row?.urlIndex));
    tr.dataset.attempt = String(Math.max(1, integer(row?.attempt, 1)));
    tr.setAttribute('aria-label', rowLabel(row));
    appendText(documentRef, tr, 'th', integer(row?.urlIndex), { scope: 'row' });
    appendText(documentRef, tr, 'td', row?.url || '—');
    appendText(documentRef, tr, 'td', row?.profileLabel || '未分配');
    appendText(documentRef, tr, 'td', row?.promotionSiteLabel || '未分配');
    appendPreviewCell(documentRef, tr, row?.commentText);
    appendPreviewCell(
      documentRef,
      tr,
      Array.isArray(row?.anchorTexts) ? row.anchorTexts.join(' · ') : ''
    );
    appendPreviewCell(documentRef, tr, row?.promotedWebsiteUrl);
    appendText(documentRef, tr, 'td', rowStatusLabel(row));
    appendText(documentRef, tr, 'td', formatElapsed(row?.elapsedMs));
    appendText(documentRef, tr, 'td', rowSummary(row));
    appendText(documentRef, tr, 'td', tabLabel(snapshot, row));
    const actionCell = documentRef.createElement('td');
    renderRowActions(
      documentRef,
      actionCell,
      row,
      Boolean(commandState(snapshot).inFlight)
    );
    tr.appendChild(actionCell);
    body.appendChild(tr);
  }
  table.appendChild(body);
  wrapper.appendChild(table);
  return wrapper;
}

function cardField(documentRef, list, term, value) {
  appendText(documentRef, list, 'dt', term);
  appendText(documentRef, list, 'dd', value);
}

function appendPreviewValue(documentRef, parent, value) {
  const fullText = text(value);
  if (!fullText) {
    appendText(documentRef, parent, 'span', '—');
    return;
  }
  const preview = appendText(documentRef, parent, 'span', fullText, {
    class: 'batch-console__preview-value',
    title: fullText,
    tabIndex: 0
  });
  preview.dataset.previewValue = '';
}

function appendPreviewCell(documentRef, row, value) {
  const cell = documentRef.createElement('td');
  cell.className = 'batch-console__preview-cell';
  appendPreviewValue(documentRef, cell, value);
  row.appendChild(cell);
}

function cardPreviewField(documentRef, list, term, value) {
  appendText(documentRef, list, 'dt', term);
  const detail = documentRef.createElement('dd');
  appendPreviewValue(documentRef, detail, value);
  list.appendChild(detail);
}

function renderCards(documentRef, snapshot, rows) {
  const list = documentRef.createElement('div');
  list.className = 'batch-console__cards';
  list.dataset.taskCards = '';
  for (const row of rows) {
    const article = documentRef.createElement('article');
    article.className = 'batch-console__card';
    article.dataset.taskCard = String(integer(row?.urlIndex));
    article.dataset.attempt = String(Math.max(1, integer(row?.attempt, 1)));
    article.setAttribute('aria-label', rowLabel(row));
    appendText(
      documentRef,
      article,
      'h3',
      `序号 ${integer(row?.urlIndex)} · ${rowStatusLabel(row)}`
    );
    const details = documentRef.createElement('dl');
    cardField(documentRef, details, 'URL', row?.url || '—');
    cardField(documentRef, details, '域名', row?.domain || '—');
    cardField(documentRef, details, '身份', row?.profileLabel || '未分配');
    cardField(
      documentRef,
      details,
      '推广网站',
      row?.promotionSiteLabel || '未分配'
    );
    cardPreviewField(documentRef, details, '评论文本', row?.commentText);
    cardPreviewField(
      documentRef,
      details,
      '锚文本',
      Array.isArray(row?.anchorTexts) ? row.anchorTexts.join(' · ') : ''
    );
    cardPreviewField(
      documentRef,
      details,
      '推广网址',
      row?.promotedWebsiteUrl
    );
    cardField(documentRef, details, '耗时', formatElapsed(row?.elapsedMs));
    cardField(documentRef, details, '阶段或错误', rowSummary(row));
    cardField(documentRef, details, 'worker 标签页', tabLabel(snapshot, row));
    article.appendChild(details);
    renderRowActions(
      documentRef,
      article,
      row,
      Boolean(commandState(snapshot).inFlight)
    );
    list.appendChild(article);
  }
  return list;
}

function renderQueue(documentRef, snapshot, toolbar = null) {
  const section = documentRef.createElement('section');
  section.className = 'batch-console__queue';
  section.setAttribute('aria-labelledby', 'batch-console-queue');
  appendText(documentRef, section, 'h2', '目标队列', { id: 'batch-console-queue' });
  section.appendChild(renderToolbar(documentRef, snapshot, toolbar));
  const rows = visibleRows(snapshot);
  if (rows.length === 0) {
    appendText(
      documentRef,
      section,
      'p',
      allRows(snapshot).length === 0
        ? '当前批次没有目标。'
        : '没有符合当前筛选条件的目标。',
      { class: 'batch-console__queue-empty', 'data-queue-empty': '' }
    );
    return section;
  }
  section.append(
    renderTable(documentRef, snapshot, rows),
    renderCards(documentRef, snapshot, rows)
  );
  return section;
}

function renderEmpty(documentRef) {
  const section = documentRef.createElement('section');
  section.className = 'batch-console__empty';
  section.dataset.consoleEmpty = '';
  appendText(documentRef, section, 'h2', '尚无批次');
  appendText(
    documentRef,
    section,
    'p',
    '新建批次后，可在这里查看 worker 标签页、完整队列和恢复状态。'
  );
  return section;
}

function appendDetail(documentRef, list, term, value) {
  appendText(documentRef, list, 'dt', term);
  appendText(documentRef, list, 'dd', value || '—');
}

function renderDrawer(documentRef, row, snapshot) {
  const overlay = documentRef.createElement('div');
  overlay.className = 'batch-console__overlay';
  overlay.dataset.consoleLayer = '';
  const drawer = documentRef.createElement('aside');
  drawer.className = 'batch-console__drawer';
  drawer.dataset.taskDrawer = String(integer(row?.urlIndex));
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-labelledby', 'batch-console-drawer-title');
  drawer.tabIndex = -1;
  const header = documentRef.createElement('header');
  appendText(
    documentRef,
    header,
    'h2',
    `任务详情 · 序号 ${integer(row?.urlIndex)}`,
    { id: 'batch-console-drawer-title' }
  );
  const close = button(documentRef, header, '关闭详情', 'close-layer', {
    ariaLabel: '关闭任务详情'
  });
  close.dataset.drawerClose = '';
  drawer.appendChild(header);

  const details = documentRef.createElement('dl');
  appendDetail(documentRef, details, 'URL', row?.url);
  appendDetail(documentRef, details, '任务身份', row?.taskId);
  appendDetail(documentRef, details, 'Profile', row?.profileLabel);
  appendDetail(documentRef, details, 'Promotion Site', row?.promotionSiteLabel);
  appendDetail(documentRef, details, '评论文本', row?.commentText);
  appendDetail(
    documentRef,
    details,
    '锚文本',
    Array.isArray(row?.anchorTexts) ? row.anchorTexts.join(' · ') : null
  );
  appendDetail(documentRef, details, '推广网址', row?.promotedWebsiteUrl);
  appendDetail(documentRef, details, '分配来源', row?.assignmentSource);
  appendDetail(documentRef, details, '当前尝试', row?.attempt);
  appendDetail(documentRef, details, '状态', rowStatusLabel(row));
  appendDetail(documentRef, details, '阶段', phaseLabel(row?.phase));
  appendDetail(documentRef, details, '耗时', formatElapsed(row?.elapsedMs));
  appendDetail(documentRef, details, 'worker 标签页', tabLabel(snapshot, row));
  appendDetail(documentRef, details, '错误码', row?.error?.code);
  appendDetail(documentRef, details, '错误消息', rowErrorMessage(row));
  appendDetail(documentRef, details, 'AI 内容', row?.aiContent);
  appendDetail(
    documentRef,
    details,
    '人工处置',
    row?.manualResolution?.status || 'idle'
  );
  drawer.appendChild(details);

  const history = documentRef.createElement('section');
  appendText(documentRef, history, 'h3', '尝试历史');
  const historyList = documentRef.createElement('ol');
  const attempts = Array.isArray(row?.attemptHistory) ? row.attemptHistory : [];
  if (attempts.length === 0) {
    appendText(documentRef, historyList, 'li', '暂无更早尝试');
  } else {
    for (const attempt of attempts) {
      appendText(
        documentRef,
        historyList,
        'li',
        `尝试 ${integer(attempt?.attempt)} · ${text(attempt?.result, '未知')} · `
          + `${text(attempt?.error?.message, '无错误')} · `
          + `${formatElapsed(attempt?.elapsedMs)}`
      );
    }
  }
  history.appendChild(historyList);
  drawer.appendChild(history);

  const actions = documentRef.createElement('footer');
  renderRowActions(
    documentRef,
    actions,
    row,
    Boolean(commandState(snapshot).inFlight)
  );
  drawer.appendChild(actions);
  overlay.appendChild(drawer);
  return overlay;
}

function renderConfirmation(documentRef, kind, row, busy) {
  const definitions = {
    pause: {
      title: '安全暂停批次？',
      message: '暂停会封存活动任务并关闭 worker 标签页，稍后可继续。',
      confirm: '安全暂停',
      danger: false
    },
    stop: {
      title: '永久停止批次？',
      message: '已有结果会保留并可导出；剩余任务不会继续，原批次不能恢复。如需重跑必须新建批次。',
      confirm: '停止并保留结果',
      danger: true
    },
    retry: {
      title: '确认高风险重试？',
      message: '提交状态不确定，建议先人工检查。继续重试可能产生重复评论。',
      confirm: '确认风险并重新排队',
      danger: true
    }
  };
  const definition = definitions[kind];
  const overlay = documentRef.createElement('div');
  overlay.className = 'batch-console__overlay';
  overlay.dataset.consoleLayer = '';
  const dialog = documentRef.createElement('section');
  dialog.className = 'batch-console__dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'batch-console-dialog-title');
  dialog.setAttribute('aria-busy', String(busy));
  dialog.tabIndex = -1;
  appendText(
    documentRef,
    dialog,
    'h2',
    definition.title,
    { id: 'batch-console-dialog-title' }
  );
  appendText(documentRef, dialog, 'p', definition.message);
  const actions = documentRef.createElement('footer');
  const cancel = button(documentRef, actions, '取消', 'close-layer');
  cancel.dataset.dialogCancel = '';
  cancel.disabled = busy;
  const confirm = button(documentRef, actions, definition.confirm, 'confirm-layer', {
    className: definition.danger
      ? 'batch-console__button batch-console__button--danger'
      : 'batch-console__button batch-console__button--primary',
    urlIndex: row?.urlIndex,
    attempt: row?.attempt,
    disabled: busy
  });
  confirm.dataset.dialogConfirm = '';
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  return overlay;
}

function focusKeyFor(element) {
  if (!element?.dataset) return null;
  if (element.dataset.action) {
    return {
      action: element.dataset.action,
      urlIndex: element.dataset.urlIndex ?? null,
      attempt: element.dataset.attempt ?? null
    };
  }
  return null;
}

function findByFocusKey(root, key) {
  if (!key?.action) return null;
  return [...root.querySelectorAll('[data-action]')].find((element) => (
    element.dataset.action === key.action &&
    (key.urlIndex === null || element.dataset.urlIndex === key.urlIndex) &&
    (key.attempt === null || element.dataset.attempt === key.attempt)
  )) || null;
}

export function createBatchConsoleView(documentRef, handlers = {}) {
  const root = documentRef?.querySelector?.('[data-batch-console]');
  if (!root) throw new Error('batch_console_mount_missing');

  let snapshot = null;
  let layer = null;
  let returnFocus = null;
  let returnFocusKey = null;
  let shell = null;
  let lastFilterKey = null;
  let destroyed = false;

  function rowFromElement(element) {
    const urlIndex = Number(element?.dataset?.urlIndex);
    const attempt = Number(element?.dataset?.attempt);
    return allRows(snapshot).find((row) => (
      row?.urlIndex === urlIndex &&
      (Number.isInteger(attempt) ? row?.attempt === attempt : true)
    )) || null;
  }

  function isolateLayerBackground(layerElement) {
    for (const child of root.children) {
      if (child === layerElement) continue;
      child.setAttribute('inert', '');
      child.inert = true;
      child.setAttribute('aria-hidden', 'true');
    }
  }

  function clearLayerBackground() {
    for (const child of root.children) {
      child.removeAttribute('inert');
      child.inert = false;
      child.removeAttribute('aria-hidden');
    }
  }

  function layerElement() {
    return root.querySelector('[data-console-layer]');
  }

  function removeRenderedLayer() {
    for (const element of root.querySelectorAll('[data-console-layer]')) {
      element.remove();
    }
    clearLayerBackground();
  }

  function focusLayer() {
    const container = layerElement()?.querySelector('[role="dialog"]');
    if (!container) return;
    const first = container.querySelector(FOCUSABLE_SELECTOR);
    (first || container).focus();
  }

  function renderLayer(preferredFocusKey = null) {
    removeRenderedLayer();
    if (!layer) return;
    const command = commandState(snapshot);
    const row = layer.rowIdentity
      ? allRows(snapshot).find((candidate) => (
          candidate?.urlIndex === layer.rowIdentity.urlIndex &&
          candidate?.attempt === layer.rowIdentity.attempt
        ))
      : null;
    if (layer.type === 'drawer' && !row) {
      if (layer.parent) {
        const parentFocusKey = layer.parentFocusKey;
        layer = layer.parent;
        renderLayer(parentFocusKey);
      } else {
        layer = null;
      }
      return;
    }
    const element = layer.type === 'drawer'
      ? renderDrawer(documentRef, row, snapshot)
      : renderConfirmation(
          documentRef,
          layer.kind,
          row,
          Boolean(command.inFlight)
        );
    root.appendChild(element);
    isolateLayerBackground(element);
    const preferred = findByFocusKey(element, preferredFocusKey);
    if (preferred) preferred.focus();
    else focusLayer();
  }

  function ensureShell() {
    if (shell) return;
    root.textContent = '';
    root.className = 'batch-console';
    const commandBar = renderCommandBar(documentRef, snapshot);
    const banners = renderBanners(documentRef, snapshot);
    const summary = renderSummary(documentRef, snapshot);
    const content = documentRef.createElement('div');
    content.dataset.consoleContent = '';
    root.append(commandBar, banners, summary, content);
    shell = { commandBar, banners, summary, content };
  }

  function toolbarFocusState(toolbar) {
    const active = documentRef.activeElement;
    if (!toolbar?.contains(active)) return null;
    const state = {
      element: active,
      selectionStart: null,
      selectionEnd: null,
      selectionDirection: null
    };
    if (typeof active.selectionStart === 'number') {
      state.selectionStart = active.selectionStart;
      state.selectionEnd = active.selectionEnd;
      state.selectionDirection = active.selectionDirection;
    }
    return state;
  }

  function restoreToolbarFocus(state) {
    if (!state?.element?.isConnected) return;
    state.element.focus();
    if (
      state.selectionStart !== null &&
      typeof state.element.setSelectionRange === 'function'
    ) {
      state.element.setSelectionRange(
        state.selectionStart,
        state.selectionEnd,
        state.selectionDirection || undefined
      );
    }
  }

  function renderCurrent() {
    if (destroyed || !snapshot) return;
    removeRenderedLayer();
    ensureShell();
    const toolbar = shell.content.querySelector('.batch-console__toolbar');
    const toolbarFocus = toolbarFocusState(toolbar);
    toolbar?.remove();
    updateCommandBar(documentRef, shell.commandBar, snapshot);
    updateBanners(documentRef, shell.banners, snapshot);
    updateSummary(shell.summary, snapshot);
    shell.content.textContent = '';

    if (!snapshot.batchId || snapshot.status === 'empty') {
      shell.content.appendChild(renderEmpty(documentRef));
    } else {
      const layout = documentRef.createElement('div');
      layout.className = 'batch-console__layout';
      layout.append(
        renderOverview(documentRef, snapshot),
        renderQueue(documentRef, snapshot, toolbar)
      );
      shell.content.appendChild(layout);
    }
    restoreToolbarFocus(toolbarFocus);
    renderLayer();
  }

  function openLayer(nextLayer, trigger) {
    if (layer) {
      nextLayer.parent = layer;
      nextLayer.parentFocusKey = focusKeyFor(trigger || documentRef.activeElement);
    } else {
      returnFocus = trigger || documentRef.activeElement;
      returnFocusKey = focusKeyFor(returnFocus);
    }
    layer = nextLayer;
    renderLayer();
  }

  function closeLayer({ restoreFocus = true } = {}) {
    if (!layer) return;
    if (layer.parent) {
      const parentFocusKey = layer.parentFocusKey;
      layer = layer.parent;
      renderLayer(parentFocusKey);
      return;
    }
    const focusTarget = returnFocus?.isConnected
      ? returnFocus
      : findByFocusKey(root, returnFocusKey);
    removeRenderedLayer();
    layer = null;
    returnFocus = null;
    returnFocusKey = null;
    if (restoreFocus) focusTarget?.focus();
  }

  function closeAllLayers({ restoreFocus = true } = {}) {
    const focusTarget = returnFocus?.isConnected
      ? returnFocus
      : findByFocusKey(root, returnFocusKey);
    removeRenderedLayer();
    layer = null;
    returnFocus = null;
    returnFocusKey = null;
    if (restoreFocus) focusTarget?.focus();
  }

  function currentFilters() {
    const current = normalizedFilters(snapshot);
    return {
      status: root.querySelector('[name="queueStatus"]')?.value || current.status,
      domain: root.querySelector('[name="queueDomain"]')?.value || current.domain,
      profile: root.querySelector('[name="queueProfile"]')?.value || current.profile,
      promotionSite: root.querySelector('[name="queuePromotionSite"]')?.value ||
        current.promotionSite,
      timeRange: root.querySelector('[name="queueTimeRange"]')?.value || current.timeRange,
      keyword: root.querySelector('[name="queueKeyword"]')?.value || ''
    };
  }

  function filterKey(filters) {
    return [
      filters.status,
      filters.domain,
      filters.profile,
      filters.promotionSite,
      filters.timeRange,
      filters.keyword
    ].join('\u0000');
  }

  function onClick(event) {
    const target = event.target.closest?.('[data-action]');
    if (!target || !root.contains(target) || target.disabled) return;
    const action = target.dataset.action;
    const row = rowFromElement(target);
    if (action === 'pause') {
      openLayer({ type: 'confirm', kind: 'pause' }, target);
      return;
    }
    if (action === 'stop') {
      openLayer({ type: 'confirm', kind: 'stop' }, target);
      return;
    }
    if (action === 'resume') {
      handlers.onResume?.();
      return;
    }
    if (action === 'retry-persistence') {
      handlers.onRetryPersistence?.();
      return;
    }
    if (action === 'new-batch') {
      handlers.onNewBatch?.();
      return;
    }
    if (action === 'export') {
      handlers.onExport?.();
      return;
    }
    if (action === 'details' && row) {
      openLayer({
        type: 'drawer',
        rowIdentity: rowIdentity(row)
      }, target);
      return;
    }
    if (action === 'focus-tab' && row) {
      handlers.onFocusTab?.(commandTask(row, snapshot));
      return;
    }
    if (action === 'retry' && row) {
      if (row.retryPolicy === 'confirm') {
        openLayer({
          type: 'confirm',
          kind: 'retry',
          rowIdentity: rowIdentity(row)
        }, target);
      } else if (row.retryPolicy !== 'blocked') {
        handlers.onRetry?.(commandTask(row, snapshot), false);
      }
      return;
    }
    if (action === 'manual' && row) {
      handlers.onOpenManual?.(commandTask(row, snapshot));
      return;
    }
    if (action === 'manual-resolved' && row) {
      handlers.onManualUpdate?.(commandTask(row, snapshot), 'resolved');
      return;
    }
    if (action === 'manual-unresolved' && row) {
      handlers.onManualUpdate?.(commandTask(row, snapshot), 'unresolved');
      return;
    }
    if (action === 'close-layer') {
      closeLayer();
      return;
    }
    if (action !== 'confirm-layer' || !layer) return;
    const confirmed = layer;
    const confirmedRow = confirmed.rowIdentity
      ? allRows(snapshot).find((candidate) => (
          candidate?.urlIndex === confirmed.rowIdentity.urlIndex &&
          candidate?.attempt === confirmed.rowIdentity.attempt
        ))
      : null;
    closeAllLayers({ restoreFocus: false });
    if (confirmed.kind === 'pause') handlers.onPause?.();
    if (confirmed.kind === 'stop') handlers.onStop?.(true);
    if (confirmed.kind === 'retry' && confirmedRow) {
      handlers.onRetry?.(commandTask(confirmedRow, snapshot), true);
    }
  }

  function onFilterEvent(event) {
    if (!root.contains(event.target)) return;
    if (![
      'queueStatus',
      'queueDomain',
      'queueProfile',
      'queuePromotionSite',
      'queueTimeRange',
      'queueKeyword'
    ].includes(event.target.name)) return;
    if (event.target.name === 'queueKeyword' && event.type !== 'input') return;
    if (event.target.name !== 'queueKeyword' && event.type !== 'change') return;
    const next = currentFilters();
    const nextKey = filterKey(next);
    if (nextKey === lastFilterKey) return;
    lastFilterKey = nextKey;
    const focusState = toolbarFocusState(
      root.querySelector('.batch-console__toolbar')
    );
    handlers.onFilterChange?.(next);
    restoreToolbarFocus(focusState);
  }

  function focusableInLayer() {
    const container = layerElement()?.querySelector('[role="dialog"]');
    if (!container) return [];
    return [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => (
      !element.disabled && !element.closest('[hidden]')
    ));
  }

  function onKeydown(event) {
    if (!layer) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      const protectedTransition = layer.type === 'confirm' &&
        Boolean(commandState(snapshot).inFlight);
      if (!protectedTransition) closeLayer();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableInLayer();
    const container = layerElement()?.querySelector('[role="dialog"]');
    if (focusable.length === 0) {
      event.preventDefault();
      container?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && documentRef.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && documentRef.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onFocusIn(event) {
    if (!layer) return;
    const container = layerElement()?.querySelector('[role="dialog"]');
    if (!container || container.contains(event.target)) return;
    event.stopPropagation();
    focusLayer();
  }

  root.addEventListener('click', onClick);
  root.addEventListener('input', onFilterEvent);
  root.addEventListener('change', onFilterEvent);
  documentRef.addEventListener('keydown', onKeydown, true);
  documentRef.addEventListener('focusin', onFocusIn, true);

  return {
    render(nextSnapshot) {
      if (destroyed) return;
      snapshot = nextSnapshot && typeof nextSnapshot === 'object'
        ? nextSnapshot
        : {};
      lastFilterKey = filterKey(normalizedFilters(snapshot));
      renderCurrent();
    },
    destroy() {
      if (destroyed) return;
      closeAllLayers({ restoreFocus: false });
      destroyed = true;
      root.removeEventListener('click', onClick);
      root.removeEventListener('input', onFilterEvent);
      root.removeEventListener('change', onFilterEvent);
      documentRef.removeEventListener('keydown', onKeydown, true);
      documentRef.removeEventListener('focusin', onFocusIn, true);
      root.textContent = '';
    }
  };
}
