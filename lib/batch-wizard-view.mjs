import { withDuplicateIncluded } from './batch-preflight.mjs';

const STEP_LABELS = ['分配配置', '导入与预检', '执行设置', '确认并开始'];
const SENSITIVE_KEY = /(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|credential)/i;
const ROW_STATUSES = new Set(['eligible', 'duplicate', 'blocked', 'invalid']);
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function text(value) {
  return String(value || '').trim();
}

function normalizeAssignment(assignment = {}) {
  const identitySnapshot = assignment.identitySnapshot || {};
  const promotionSiteSnapshot = assignment.promotionSiteSnapshot || {};
  return {
    identityId: text(assignment.identityId),
    promotionSiteId: text(assignment.promotionSiteId),
    identitySnapshot: {
      displayName: text(identitySnapshot.displayName),
      email: text(identitySnapshot.email)
    },
    promotionSiteSnapshot: {
      label: text(promotionSiteSnapshot.label),
      url: text(promotionSiteSnapshot.url),
      contentSummary: text(promotionSiteSnapshot.contentSummary)
    }
  };
}

function normalizeSettings(settings = {}) {
  const autoSubmit = Boolean(settings.autoSubmit);
  const autoGenerate = autoSubmit || settings.autoGenerate !== false;
  return {
    autoOpenPanel: Boolean(settings.autoOpenPanel),
    autoGenerate,
    autoSubmit,
    concurrency: clampInteger(settings.concurrency, 1, 10, 3),
    timeoutSeconds: clampInteger(settings.timeoutSeconds, 10, 600, 60)
  };
}

function redactSensitiveColumns(row, sensitiveColumns) {
  if (!Array.isArray(row)) return undefined;
  return row.map((value, index) => (
    sensitiveColumns.has(index) ? '[REDACTED]' : value
  ));
}

function normalizePreflightRow(row, index, sensitiveColumns) {
  const source = row && !Array.isArray(row) ? row : {};
  const status = ROW_STATUSES.has(source.status) ? source.status : 'invalid';
  return {
    rowNumber: Number.isInteger(source.rowNumber) ? source.rowNumber : index + 2,
    originalRow: redactSensitiveColumns(
      Array.isArray(row) ? row : source.originalRow,
      sensitiveColumns
    ),
    url: typeof source.url === 'string' ? source.url : null,
    sourceDomain: text(source.sourceDomain),
    status,
    reasonCode: text(source.reasonCode),
    reason: text(source.reason),
    overridable: status === 'duplicate',
    included: status === 'eligible'
      ? true
      : status === 'duplicate' && source.included === true
  };
}

function summarizePreflightRows(rows) {
  const summary = {
    raw: rows.length,
    eligible: 0,
    duplicate: 0,
    blocked: 0,
    invalid: 0,
    included: 0
  };
  for (const row of rows) {
    summary[row.status] += 1;
    if (row.included) summary.included += 1;
  }
  return summary;
}

function clonePreflight(preflight) {
  if (!preflight || !Array.isArray(preflight.rows)) return null;
  const headers = Array.isArray(preflight.headers)
    ? preflight.headers.map((header) => String(header || '').trim())
    : [];
  const sensitiveColumns = new Set(headers.flatMap((header, index) => (
    SENSITIVE_KEY.test(header) ? [index] : []
  )));
  const rows = preflight.rows.map((row, index) => (
    normalizePreflightRow(row, index, sensitiveColumns)
  ));
  return {
    headers,
    rows,
    summary: summarizePreflightRows(rows)
  };
}

function normalizeDraft(source = {}) {
  return {
    step: clampInteger(source.step, 1, STEP_LABELS.length, 1),
    assignment: normalizeAssignment(source.assignment),
    preflight: clonePreflight(source.preflight),
    settings: normalizeSettings(source.settings),
    readinessError: text(source.readinessError),
    parseError: text(source.parseError)
  };
}

function cloneDraft(draft) {
  return normalizeDraft(draft);
}

function assignmentIsReady(assignment) {
  return Boolean(
    assignment.identityId
    && assignment.promotionSiteId
    && assignment.identitySnapshot.displayName
    && assignment.identitySnapshot.email
    && assignment.promotionSiteSnapshot.label
    && assignment.promotionSiteSnapshot.url
    && assignment.promotionSiteSnapshot.contentSummary
  );
}

function includedRunnableRows(preflight) {
  if (!preflight?.rows) return [];
  return preflight.rows.filter((row) => (
    row.included === true
    && (row.status === 'eligible' || row.status === 'duplicate')
  ));
}

function appendText(documentRef, parent, tagName, value, attributes = {}) {
  const element = documentRef.createElement(tagName);
  element.textContent = value;
  for (const [name, attributeValue] of Object.entries(attributes)) {
    if (attributeValue !== undefined && attributeValue !== null) {
      element.setAttribute(name, String(attributeValue));
    }
  }
  parent.appendChild(element);
  return element;
}

function field(documentRef, { label, name, value, type = 'text', min, max }) {
  const wrapper = documentRef.createElement('div');
  wrapper.className = 'batch-wizard__field';
  const id = `batch-wizard-${name}`;
  appendText(documentRef, wrapper, 'label', label, { for: id });
  const input = documentRef.createElement('input');
  input.id = id;
  input.name = name;
  input.type = type;
  input.value = String(value);
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  wrapper.appendChild(input);
  return wrapper;
}

function checkbox(documentRef, { label, name, checked }) {
  const wrapper = documentRef.createElement('label');
  wrapper.className = 'batch-wizard__checkbox';
  const input = documentRef.createElement('input');
  input.type = 'checkbox';
  input.name = name;
  input.checked = checked;
  wrapper.append(input, documentRef.createTextNode(label));
  return wrapper;
}

function section(documentRef, step, label) {
  const item = documentRef.createElement('section');
  item.className = 'batch-wizard__step';
  item.dataset.wizardStep = String(step);
  item.hidden = true;
  const headingId = `batch-wizard-step-${step}`;
  item.setAttribute('aria-labelledby', headingId);
  appendText(documentRef, item, 'h2', label, { id: headingId, tabindex: '-1' });
  return item;
}

function renderAssignmentStep(documentRef, draft) {
  const item = section(documentRef, 1, STEP_LABELS[0]);
  appendText(
    documentRef,
    item,
    'p',
    '选择本批次使用的身份与推广网站。此处只保存配置标识和只读快照。'
  );
  const fields = documentRef.createElement('div');
  fields.className = 'batch-wizard__assignment-grid';
  fields.append(
    field(documentRef, {
      label: '身份配置 ID',
      name: 'identityId',
      value: draft.assignment.identityId
    }),
    field(documentRef, {
      label: '推广网站 ID',
      name: 'promotionSiteId',
      value: draft.assignment.promotionSiteId
    })
  );
  item.appendChild(fields);

  const snapshots = documentRef.createElement('div');
  snapshots.className = 'batch-wizard__snapshot-grid';
  const identity = documentRef.createElement('article');
  appendText(documentRef, identity, 'h3', '身份快照');
  appendText(
    documentRef,
    identity,
    'p',
    draft.assignment.identitySnapshot.displayName || '未配置显示名称'
  );
  appendText(
    documentRef,
    identity,
    'p',
    draft.assignment.identitySnapshot.email || '未配置邮箱'
  );
  const promotion = documentRef.createElement('article');
  appendText(documentRef, promotion, 'h3', '推广网站快照');
  appendText(
    documentRef,
    promotion,
    'p',
    draft.assignment.promotionSiteSnapshot.label || '未配置网站'
  );
  appendText(
    documentRef,
    promotion,
    'p',
    draft.assignment.promotionSiteSnapshot.url || '未配置 URL'
  );
  appendText(
    documentRef,
    promotion,
    'p',
    draft.assignment.promotionSiteSnapshot.contentSummary || '未配置网站说明'
  );
  snapshots.append(identity, promotion);
  item.appendChild(snapshots);

  if (!assignmentIsReady(draft.assignment)) {
    appendText(
      documentRef,
      item,
      'p',
      '请先在身份配置与推广网站中补全必填信息。',
      { class: 'batch-wizard__error', role: 'alert', 'data-assignment-error': '' }
    );
  }
  return item;
}

function renderPreflightTable(documentRef, preflight) {
  const wrapper = documentRef.createElement('div');
  wrapper.className = 'batch-wizard__table-wrap';
  wrapper.dataset.preflightTableWrap = '';
  wrapper.tabIndex = 0;
  wrapper.setAttribute('aria-label', 'CSV 预检结果，可横向滚动');
  const table = documentRef.createElement('table');
  table.className = 'batch-wizard__table';
  const caption = appendText(documentRef, table, 'caption', 'CSV 逐行预检结果');
  caption.className = 'sr-only';
  const head = documentRef.createElement('thead');
  const headRow = documentRef.createElement('tr');
  for (const label of ['行', 'URL', '状态', '说明', '处理']) {
    appendText(documentRef, headRow, 'th', label, { scope: 'col' });
  }
  head.appendChild(headRow);
  table.appendChild(head);

  const body = documentRef.createElement('tbody');
  for (const row of preflight.rows) {
    const tableRow = documentRef.createElement('tr');
    tableRow.dataset.preflightRow = String(row.rowNumber);
    tableRow.dataset.included = String(row.included === true);
    tableRow.dataset.status = text(row.status);
    appendText(documentRef, tableRow, 'th', String(row.rowNumber), { scope: 'row' });
    appendText(documentRef, tableRow, 'td', row.url || '—');
    appendText(documentRef, tableRow, 'td', text(row.status) || 'unknown');
    appendText(documentRef, tableRow, 'td', text(row.reason) || '—');
    const actionCell = documentRef.createElement('td');
    if (row.status === 'duplicate' && row.overridable === true) {
      const button = appendText(
        documentRef,
        actionCell,
        'button',
        row.included ? '排除此重复项' : '包含此重复项',
        {
          type: 'button',
          'data-action': 'toggle-duplicate',
          'data-row-number': row.rowNumber,
          'aria-pressed': String(row.included === true)
        }
      );
      button.className = 'batch-wizard__text-action';
    } else {
      appendText(
        documentRef,
        actionCell,
        'span',
        row.included ? '已包含' : '不可包含'
      );
    }
    tableRow.appendChild(actionCell);
    body.appendChild(tableRow);
  }
  table.appendChild(body);
  wrapper.appendChild(table);
  return wrapper;
}

function renderImportStep(documentRef, draft) {
  const item = section(documentRef, 2, STEP_LABELS[1]);
  appendText(
    documentRef,
    item,
    'p',
    '导入 CSV 后会先在本地检查 URL、重复项和非法站点。'
  );
  const input = documentRef.createElement('input');
  input.id = 'batch-wizard-file';
  input.className = 'batch-wizard__file';
  input.type = 'file';
  input.name = 'batchFile';
  input.accept = '.csv,text/csv';
  const dropZone = appendText(
    documentRef,
    item,
    'label',
    '选择 CSV 文件，或拖放到这里',
    {
      for: input.id,
      'data-import-drop-zone': ''
    }
  );
  dropZone.className = 'batch-wizard__drop-zone';
  item.insertBefore(input, dropZone);

  if (draft.parseError) {
    appendText(documentRef, item, 'p', draft.parseError, {
      class: 'batch-wizard__error',
      role: 'alert',
      'data-parse-error': ''
    });
  }

  if (!draft.preflight) {
    appendText(documentRef, item, 'p', '尚未导入可预检的 CSV 文件。', {
      class: 'batch-wizard__empty',
      'data-preflight-empty': ''
    });
    return item;
  }

  const summary = draft.preflight.summary;
  appendText(
    documentRef,
    item,
    'p',
    `共 ${summary.raw} 行；将处理 ${includedRunnableRows(draft.preflight).length} 行；`
      + `重复 ${summary.duplicate}，拦截 ${summary.blocked}，无效 ${summary.invalid}。`,
    { class: 'batch-wizard__summary', 'data-preflight-summary': '', 'aria-live': 'polite' }
  );
  item.appendChild(renderPreflightTable(documentRef, draft.preflight));
  return item;
}

function renderSettingsStep(documentRef, draft) {
  const item = section(documentRef, 3, STEP_LABELS[2]);
  appendText(documentRef, item, 'p', '设置本批次的并发、超时和自动化范围。');
  const fields = documentRef.createElement('div');
  fields.className = 'batch-wizard__settings-grid';
  fields.append(
    field(documentRef, {
      label: '并发任务数（1–10）',
      name: 'concurrency',
      type: 'number',
      value: draft.settings.concurrency,
      min: 1,
      max: 10
    }),
    field(documentRef, {
      label: '单项超时秒数（10–600）',
      name: 'timeoutSeconds',
      type: 'number',
      value: draft.settings.timeoutSeconds,
      min: 10,
      max: 600
    })
  );
  item.appendChild(fields);
  const toggles = documentRef.createElement('div');
  toggles.className = 'batch-wizard__toggles';
  toggles.append(
    checkbox(documentRef, {
      label: '自动打开操作面板',
      name: 'autoOpenPanel',
      checked: draft.settings.autoOpenPanel
    }),
    checkbox(documentRef, {
      label: '自动生成评论',
      name: 'autoGenerate',
      checked: draft.settings.autoGenerate
    }),
    checkbox(documentRef, {
      label: '自动提交评论（会同时启用自动生成）',
      name: 'autoSubmit',
      checked: draft.settings.autoSubmit
    })
  );
  item.appendChild(toggles);
  return item;
}

function renderConfirmationStep(documentRef, draft, readinessError) {
  const item = section(documentRef, 4, STEP_LABELS[3]);
  appendText(documentRef, item, 'p', '确认本批次配置；开始后可在批次控制台跟踪结果。');
  const summary = documentRef.createElement('dl');
  summary.className = 'batch-wizard__confirmation';
  const entries = [
    ['身份', draft.assignment.identitySnapshot.displayName || '未配置'],
    ['推广网站', draft.assignment.promotionSiteSnapshot.label || '未配置'],
    ['处理行数', String(includedRunnableRows(draft.preflight).length)],
    ['并发', String(draft.settings.concurrency)],
    ['单项超时', `${draft.settings.timeoutSeconds} 秒`]
  ];
  for (const [term, description] of entries) {
    appendText(documentRef, summary, 'dt', term);
    appendText(documentRef, summary, 'dd', description);
  }
  item.appendChild(summary);
  if (readinessError) {
    appendText(documentRef, item, 'p', readinessError, {
      class: 'batch-wizard__error',
      role: 'alert',
      'data-readiness-error': ''
    });
  } else {
    appendText(documentRef, item, 'p', '已就绪，可以开始批次。', {
      class: 'batch-wizard__ready',
      'data-readiness-ready': ''
    });
  }
  return item;
}

function stepIsReady(draft, step, readinessError) {
  if (step === 1) return assignmentIsReady(draft.assignment);
  if (step === 2) return includedRunnableRows(draft.preflight).length > 0;
  if (step === 3) return true;
  return assignmentIsReady(draft.assignment)
    && includedRunnableRows(draft.preflight).length > 0
    && !readinessError;
}

function readinessFor(draft, handlers) {
  if (typeof handlers.getReadinessError === 'function') {
    try {
      return text(handlers.getReadinessError(cloneDraft(draft)));
    } catch (_) {
      return '无法确认批次是否已就绪';
    }
  }
  return draft.readinessError;
}

export function createBatchWizardView(documentRef, handlers = {}) {
  const dialog = documentRef?.querySelector?.('[data-batch-wizard]');
  if (!dialog) throw new Error('batch_wizard_mount_missing');

  let draft = normalizeDraft();
  let returnFocus = null;
  let opened = false;
  let destroyed = false;
  let backgroundState = [];

  function emitDraftChange() {
    handlers.onDraftChange?.(cloneDraft(draft));
  }

  function captureFocus() {
    const active = documentRef.activeElement;
    if (!opened || !dialog.contains(active)) return { stepHeading: draft.step };
    if (active.name) return { name: active.name };
    if (active.dataset?.action) {
      return {
        action: active.dataset.action,
        rowNumber: active.dataset.rowNumber || null
      };
    }
    if (active.hasAttribute?.('data-wizard-close')) return { close: true };
    return { stepHeading: draft.step };
  }

  function restoreDialogFocus(request) {
    if (!opened) return;
    let target = null;
    if (request?.name) {
      target = [...dialog.querySelectorAll('[name]')]
        .find((element) => element.name === request.name && !element.closest('[hidden]'));
    } else if (request?.action) {
      target = [...dialog.querySelectorAll('[data-action]')].find((element) => (
        element.dataset.action === request.action
        && (request.rowNumber === null
          || element.dataset.rowNumber === request.rowNumber)
        && !element.closest('[hidden]')
      ));
    } else if (request?.close) {
      target = dialog.querySelector('[data-wizard-close]');
    }
    target ||= dialog.querySelector(`#batch-wizard-step-${draft.step}`);
    target ||= dialog.querySelector('[data-wizard-close]');
    target?.focus();
    if (!dialog.contains(documentRef.activeElement)) {
      dialog.querySelector('[data-wizard-close]')?.focus();
    }
  }

  function updateDraft(nextDraft, { emit = true, focus } = {}) {
    const focusRequest = focus || captureFocus();
    draft = normalizeDraft(nextDraft);
    renderCurrent(focusRequest);
    if (emit) emitDraftChange();
  }

  function renderCurrent(focusRequest) {
    if (destroyed) return;
    const readinessError = readinessFor(draft, handlers);
    dialog.textContent = '';
    dialog.className = 'batch-wizard';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-labelledby', 'batch-wizard-title');
    dialog.setAttribute('aria-modal', 'true');

    const panel = documentRef.createElement('div');
    panel.className = 'batch-wizard__panel';
    const header = documentRef.createElement('header');
    header.className = 'batch-wizard__header';
    appendText(documentRef, header, 'h1', '新建批次', { id: 'batch-wizard-title' });
    const close = appendText(documentRef, header, 'button', '关闭向导', {
      type: 'button',
      'data-wizard-close': '',
      'data-action': 'wizard-cancel',
      'aria-label': '关闭新建批次向导'
    });
    close.className = 'batch-wizard__close';
    panel.appendChild(header);

    const steps = documentRef.createElement('ol');
    steps.className = 'batch-wizard__steps';
    steps.dataset.wizardSteps = '';
    STEP_LABELS.forEach((label, index) => {
      const listItem = documentRef.createElement('li');
      const marker = appendText(
        documentRef,
        listItem,
        'span',
        label,
        index + 1 === draft.step ? { 'aria-current': 'step' } : {}
      );
      marker.dataset.stepNumber = String(index + 1);
      steps.appendChild(listItem);
    });
    panel.appendChild(steps);

    const content = documentRef.createElement('div');
    content.className = 'batch-wizard__content';
    const sections = [
      renderAssignmentStep(documentRef, draft),
      renderImportStep(documentRef, draft),
      renderSettingsStep(documentRef, draft),
      renderConfirmationStep(documentRef, draft, readinessError)
    ];
    for (const item of sections) {
      item.hidden = Number(item.dataset.wizardStep) !== draft.step;
      content.appendChild(item);
    }
    panel.appendChild(content);

    const footer = documentRef.createElement('footer');
    footer.className = 'batch-wizard__footer';
    const cancel = appendText(documentRef, footer, 'button', '取消', {
      type: 'button',
      'data-action': 'wizard-cancel'
    });
    cancel.className = 'batch-wizard__button batch-wizard__button--secondary';
    if (draft.step > 1) {
      const back = appendText(documentRef, footer, 'button', '上一步', {
        type: 'button',
        'data-action': 'wizard-back'
      });
      back.className = 'batch-wizard__button batch-wizard__button--secondary';
    }
    if (draft.step < STEP_LABELS.length) {
      const next = appendText(documentRef, footer, 'button', '下一步', {
        type: 'button',
        'data-action': 'wizard-next'
      });
      next.className = 'batch-wizard__button batch-wizard__button--primary';
      next.disabled = !stepIsReady(draft, draft.step, readinessError);
    } else {
      const start = appendText(documentRef, footer, 'button', '开始批次', {
        type: 'button',
        'data-action': 'wizard-start'
      });
      start.className = 'batch-wizard__button batch-wizard__button--primary';
      start.disabled = !stepIsReady(draft, 4, readinessError);
    }
    panel.appendChild(footer);
    dialog.appendChild(panel);
    restoreDialogFocus(focusRequest);
  }

  function isolateBackground() {
    if (backgroundState.length > 0) return;
    let current = dialog;
    const body = documentRef.body;
    while (current?.parentElement && current !== body) {
      const parent = current.parentElement;
      for (const sibling of parent.children) {
        if (sibling === current) continue;
        backgroundState.push({
          element: sibling,
          hadInertAttribute: sibling.hasAttribute('inert'),
          inertAttribute: sibling.getAttribute('inert'),
          hadInertProperty: 'inert' in sibling,
          inertProperty: sibling.inert,
          hadAriaHidden: sibling.hasAttribute('aria-hidden'),
          ariaHidden: sibling.getAttribute('aria-hidden')
        });
        sibling.setAttribute('inert', '');
        sibling.inert = true;
        sibling.setAttribute('aria-hidden', 'true');
      }
      current = parent;
    }
  }

  function restoreBackground() {
    for (const state of backgroundState.reverse()) {
      const { element } = state;
      if (state.hadInertAttribute) {
        element.setAttribute('inert', state.inertAttribute || '');
      } else {
        element.removeAttribute('inert');
      }
      if (state.hadInertProperty) {
        element.inert = state.inertProperty;
      } else {
        delete element.inert;
      }
      if (state.hadAriaHidden) {
        element.setAttribute('aria-hidden', state.ariaHidden);
      } else {
        element.removeAttribute('aria-hidden');
      }
    }
    backgroundState = [];
  }

  function close({ restoreFocus = true } = {}) {
    if (destroyed && !opened) return;
    if (typeof dialog.close === 'function' && dialog.hasAttribute('open')) {
      try {
        dialog.close();
      } catch (_) {
        dialog.removeAttribute('open');
      }
    }
    dialog.removeAttribute('open');
    opened = false;
    restoreBackground();
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  function cancel() {
    handlers.onCancel?.(cloneDraft(draft));
    close();
  }

  function parseSelectedFile(file) {
    if (!file) return;
    draft = normalizeDraft({ ...draft, parseError: '' });
    handlers.onParseFile?.(file, cloneDraft(draft));
  }

  function onClick(event) {
    const actionTarget = event.target.closest?.('[data-action]');
    if (!actionTarget || !dialog.contains(actionTarget)) return;
    const action = actionTarget.dataset.action;
    if (action === 'wizard-cancel') {
      cancel();
      return;
    }
    if (action === 'wizard-back' && draft.step > 1) {
      const step = draft.step - 1;
      updateDraft({ ...draft, step }, { focus: { stepHeading: step } });
      return;
    }
    if (action === 'wizard-next' && stepIsReady(
      draft,
      draft.step,
      readinessFor(draft, handlers)
    )) {
      const step = Math.min(4, draft.step + 1);
      updateDraft({ ...draft, step }, { focus: { stepHeading: step } });
      return;
    }
    if (action === 'toggle-duplicate') {
      const rowNumber = Number(actionTarget.dataset.rowNumber);
      const row = draft.preflight?.rows.find((item) => item.rowNumber === rowNumber);
      if (!row || row.status !== 'duplicate' || row.overridable !== true) return;
      updateDraft({
        ...draft,
        preflight: withDuplicateIncluded(draft.preflight, rowNumber, !row.included)
      }, {
        focus: { action: 'toggle-duplicate', rowNumber: String(rowNumber) }
      });
      return;
    }
    if (action === 'wizard-start' && stepIsReady(
      draft,
      4,
      readinessFor(draft, handlers)
    )) {
      handlers.onStart?.(cloneDraft(draft));
    }
  }

  function onChange(event) {
    const input = event.target;
    if (!dialog.contains(input)) return;
    if (input.type === 'file') {
      parseSelectedFile(input.files?.[0]);
      return;
    }
    if (input.name === 'identityId' || input.name === 'promotionSiteId') {
      updateDraft({
        ...draft,
        assignment: { ...draft.assignment, [input.name]: text(input.value) }
      }, { focus: { name: input.name } });
      return;
    }
    if (input.name === 'concurrency') {
      updateDraft({
        ...draft,
        settings: {
          ...draft.settings,
          concurrency: clampInteger(input.value, 1, 10, 3)
        }
      }, { focus: { name: input.name } });
      return;
    }
    if (input.name === 'timeoutSeconds') {
      updateDraft({
        ...draft,
        settings: {
          ...draft.settings,
          timeoutSeconds: clampInteger(input.value, 10, 600, 60)
        }
      }, { focus: { name: input.name } });
      return;
    }
    if (['autoOpenPanel', 'autoGenerate', 'autoSubmit'].includes(input.name)) {
      const settings = { ...draft.settings, [input.name]: input.checked };
      if (input.name === 'autoSubmit' && input.checked) settings.autoGenerate = true;
      if (input.name === 'autoGenerate' && !input.checked) settings.autoSubmit = false;
      updateDraft({ ...draft, settings }, { focus: { name: input.name } });
    }
  }

  function focusableElements() {
    return [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => (
      !element.closest('[hidden]')
    ));
  }

  function onKeydown(event) {
    if (!opened) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
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

  function onDocumentFocus(event) {
    if (!opened || dialog.contains(event.target)) return;
    event.stopPropagation();
    restoreDialogFocus({ close: true });
  }

  function onDrop(event) {
    const dropZone = event.target.closest?.('[data-import-drop-zone]');
    if (!dropZone || !dialog.contains(dropZone)) return;
    event.preventDefault();
    parseSelectedFile(event.dataTransfer?.files?.[0]);
  }

  function onDragOver(event) {
    if (event.target.closest?.('[data-import-drop-zone]')) event.preventDefault();
  }

  dialog.addEventListener('click', onClick);
  dialog.addEventListener('change', onChange);
  dialog.addEventListener('drop', onDrop);
  dialog.addEventListener('dragover', onDragOver);
  documentRef.addEventListener('keydown', onKeydown, true);
  documentRef.addEventListener('focusin', onDocumentFocus, true);

  return {
    open(initialDraft = {}) {
      if (destroyed) throw new Error('batch_wizard_view_destroyed');
      returnFocus = documentRef.activeElement;
      draft = normalizeDraft(initialDraft);
      renderCurrent();
      opened = true;
      let nativeModal = false;
      if (typeof dialog.showModal === 'function') {
        try {
          dialog.showModal();
          nativeModal = true;
        } catch (_) {
          dialog.setAttribute('open', '');
        }
      } else {
        dialog.setAttribute('open', '');
      }
      if (!nativeModal) isolateBackground();
      dialog.querySelector('[data-wizard-close]')?.focus();
    },
    render(state) {
      if (destroyed) return;
      const focusRequest = captureFocus();
      draft = normalizeDraft(state);
      renderCurrent(focusRequest);
    },
    close,
    destroy() {
      if (destroyed) return;
      close();
      destroyed = true;
      dialog.removeEventListener('click', onClick);
      dialog.removeEventListener('change', onChange);
      dialog.removeEventListener('drop', onDrop);
      dialog.removeEventListener('dragover', onDragOver);
      documentRef.removeEventListener('keydown', onKeydown, true);
      documentRef.removeEventListener('focusin', onDocumentFocus, true);
      dialog.textContent = '';
    }
  };
}
