import { withDuplicateIncluded } from './batch-preflight.mjs';
import {
  sanitizeBatchUrl,
  sanitizeDiagnosticText
} from './batch-url-sanitizer.mjs';

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

function safeDomainConfig(config) {
  if (!config || !Array.isArray(config.profiles)
      || !Array.isArray(config.promotionSites)) return null;
  return {
    revision: Number.isInteger(config.revision) ? config.revision : 0,
    profiles: config.profiles.map((profile) => ({
      id: text(profile?.id),
      displayName: text(profile?.displayName)
    })),
    promotionSites: config.promotionSites.map((site) => ({
      id: text(site?.id),
      name: text(site?.name),
      enabled: site?.enabled === true
    })),
    assignmentPolicy: {
      defaultPairId: text(config.assignmentPolicy?.defaultPairId),
      pairs: Array.isArray(config.assignmentPolicy?.pairs)
        ? config.assignmentPolicy.pairs.map((pair) => ({
            id: text(pair?.id),
            profileId: text(pair?.profileId),
            promotionSiteId: text(pair?.promotionSiteId),
            weight: clampInteger(pair?.weight, 1, 100, 1),
            enabled: pair?.enabled === true
          }))
        : [],
      quotas: {
        batch: clampInteger(config.assignmentPolicy?.quotas?.batch, 1, 1_000_000, 100),
        perProfile: clampInteger(
          config.assignmentPolicy?.quotas?.perProfile, 1, 1_000_000, 50
        ),
        perPromotionSite: clampInteger(
          config.assignmentPolicy?.quotas?.perPromotionSite, 1, 1_000_000, 50
        ),
        perTargetDomain: clampInteger(
          config.assignmentPolicy?.quotas?.perTargetDomain, 1, 1_000_000, 3
        )
      }
    }
  };
}

function safeParsedCsv(parsed) {
  if (!parsed || !Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) {
    return null;
  }
  const sensitiveColumns = new Set(parsed.headers.flatMap((header, index) => (
    SENSITIVE_KEY.test(String(header)) ? [index] : []
  )));
  return {
    headers: parsed.headers.map((header, index) => (
      sensitiveColumns.has(index)
        ? '敏感列'
        : sanitizeDiagnosticText(text(header))
    )),
    rows: parsed.rows.map((row, index) => ({
      rowNumber: Number.isInteger(row?.rowNumber) ? row.rowNumber : index + 2,
      originalRow: Array.isArray(row?.originalRow)
        ? row.originalRow.map((cell, columnIndex) => (
            sensitiveColumns.has(columnIndex)
              ? '[REDACTED]'
              : sanitizeDiagnosticText(String(cell ?? ''))
          ))
        : []
    }))
  };
}

function safeMapping(mapping) {
  if (!mapping || typeof mapping !== 'object') return null;
  return Object.fromEntries([
    'targetUrl',
    'sourceDomain',
    'profileRef',
    'promotionSiteRef'
  ].map((key) => [
    key,
    Number.isInteger(mapping[key]) ? mapping[key] : null
  ]));
}

function safePlan(plan) {
  if (!plan || !Array.isArray(plan.tasks)) return null;
  return {
    planFingerprint: text(plan.planFingerprint),
    quotas: {
      batch: Number(plan.quotas?.batch) || 0,
      perProfile: Number(plan.quotas?.perProfile) || 0,
      perPromotionSite: Number(plan.quotas?.perPromotionSite) || 0,
      perTargetDomain: Number(plan.quotas?.perTargetDomain) || 0
    },
    confirmationRequirements: Array.isArray(plan.confirmationRequirements)
      ? plan.confirmationRequirements.map(text)
      : [],
    tasks: plan.tasks.map((task, index) => ({
      urlIndex: Number.isInteger(task?.urlIndex) ? task.urlIndex : index,
      rowNumber: Number.isInteger(task?.rowNumber) ? task.rowNumber : index + 2,
      targetUrl: sanitizeBatchUrl(task?.targetUrl) || '',
      canonicalTargetUrl: sanitizeBatchUrl(task?.canonicalTargetUrl) || '',
      profileId: text(task?.profileId),
      promotionSiteId: text(task?.promotionSiteId),
      assignmentSource: text(task?.assignmentSource),
      state: task?.state === 'eligible' ? 'eligible' : 'blocked',
      blockReason: text(task?.blockReason),
      recentSuccessOverride: task?.recentSuccessOverride === true
    }))
  };
}

function countRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, count]) => (
    text(key) && Number.isInteger(count) && count >= 0
      ? [[sanitizeDiagnosticText(text(key)), count]]
      : []
  )));
}

function safePlanSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return null;
  }
  return {
    status: {
      eligible: Number.isInteger(summary.status?.eligible)
        ? Math.max(0, summary.status.eligible)
        : 0,
      blocked: Number.isInteger(summary.status?.blocked)
        ? Math.max(0, summary.status.blocked)
        : 0
    },
    byBlockReason: countRecord(summary.byBlockReason),
    byAssignmentPair: countRecord(summary.byAssignmentPair),
    byProfile: countRecord(summary.byProfile),
    byPromotionSite: countRecord(summary.byPromotionSite),
    byTargetDomain: countRecord(summary.byTargetDomain)
  };
}

function safeConfirmation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    version: Number.isInteger(value.version) ? value.version : 0,
    planFingerprint: text(value.planFingerprint),
    normalConfirmed: value.normalConfirmed === true,
    requiredRisks: Array.isArray(value.requiredRisks)
      ? value.requiredRisks.map(text).filter(Boolean)
      : [],
    highRiskConfirmed: value.highRiskConfirmed === true,
    confirmedAt: Number.isInteger(value.confirmedAt) ? value.confirmedAt : 0
  };
}

function redactSensitiveColumns(row, sensitiveColumns) {
  if (!Array.isArray(row)) return undefined;
  return row.map((value, index) => (
    sensitiveColumns.has(index)
      ? '[REDACTED]'
      : typeof value === 'string'
        ? sanitizeDiagnosticText(value)
        : value
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
    url: typeof source.url === 'string' ? sanitizeBatchUrl(source.url) : null,
    sourceDomain: sanitizeDiagnosticText(text(source.sourceDomain)),
    status,
    reasonCode: sanitizeDiagnosticText(text(source.reasonCode)),
    reason: sanitizeDiagnosticText(text(source.reason)),
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
  const rawHeaders = Array.isArray(preflight.headers)
    ? preflight.headers.map((header) => String(header || '').trim())
    : [];
  const sensitiveColumns = new Set(rawHeaders.flatMap((header, index) => (
    SENSITIVE_KEY.test(header) ? [index] : []
  )));
  const headers = rawHeaders.map((header, index) => (
    sensitiveColumns.has(index) ? '敏感列' : sanitizeDiagnosticText(header)
  ));
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
    domainConfig: safeDomainConfig(source.domainConfig),
    parsedCsv: safeParsedCsv(source.parsedCsv),
    mapping: safeMapping(source.mapping),
    plan: safePlan(source.plan),
    planSummary: safePlanSummary(source.planSummary),
    confirmation: safeConfirmation(source.confirmation),
    confirmationChecks: {
      normalConfirmed: source.confirmationChecks?.normalConfirmed === true,
      highRiskConfirmed: source.confirmationChecks?.highRiskConfirmed === true
    },
    repeatOverrides: Array.isArray(source.repeatOverrides)
      ? source.repeatOverrides.map((url) => sanitizeBatchUrl(url)).filter(Boolean)
      : [],
    fileName: text(source.fileName),
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

function domainAssignmentIsReady(config) {
  if (!config) return false;
  const enabledSites = new Set(
    config.promotionSites.filter(({ enabled }) => enabled).map(({ id }) => id)
  );
  return config.assignmentPolicy.pairs.some((pair) => (
    pair.enabled && enabledSites.has(pair.promotionSiteId)
  ));
}

function draftAssignmentIsReady(draft) {
  return draft.domainConfig
    ? domainAssignmentIsReady(draft.domainConfig)
    : assignmentIsReady(draft.assignment);
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
  if (draft.domainConfig) {
    appendText(
      documentRef,
      item,
      'p',
      '本批次将使用已启用的身份 × 推广网站 Pair；CSV 可逐行显式指定，其他行按权重轮询。'
    );
    const profileNames = new Map(
      draft.domainConfig.profiles.map(({ id, displayName }) => [id, displayName])
    );
    const siteNames = new Map(
      draft.domainConfig.promotionSites.map(({ id, name }) => [id, name])
    );
    const list = documentRef.createElement('ul');
    list.dataset.assignmentPairs = '';
    for (const pair of draft.domainConfig.assignmentPolicy.pairs) {
      if (!pair.enabled) continue;
      appendText(
        documentRef,
        list,
        'li',
        `${profileNames.get(pair.profileId) || pair.profileId} × `
          + `${siteNames.get(pair.promotionSiteId) || pair.promotionSiteId}`
          + `（权重 ${pair.weight}）`
      );
    }
    item.appendChild(list);
    if (!domainAssignmentIsReady(draft.domainConfig)) {
      appendText(
        documentRef,
        item,
        'p',
        '没有可执行的启用 Pair，请先到设置中配置身份、推广网站和分配 Pair。',
        { class: 'batch-wizard__error', role: 'alert', 'data-assignment-error': '' }
      );
    }
    return item;
  }
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

function mappingSelect(documentRef, parsed, mapping, {
  label,
  name,
  key,
  required = false
}) {
  const wrapper = documentRef.createElement('div');
  wrapper.className = 'batch-wizard__field';
  appendText(documentRef, wrapper, 'label', label, { for: `batch-wizard-${name}` });
  const select = documentRef.createElement('select');
  select.id = `batch-wizard-${name}`;
  select.name = name;
  if (!required) {
    appendText(documentRef, select, 'option', '不映射', { value: '' });
  }
  parsed.headers.forEach((header, index) => {
    const option = appendText(
      documentRef,
      select,
      'option',
      `${index + 1}. ${header || `列 ${index + 1}`}`,
      { value: index }
    );
    option.selected = mapping?.[key] === index;
  });
  wrapper.appendChild(select);
  return wrapper;
}

function entityLabels(config) {
  return {
    profiles: new Map(
      (config?.profiles || []).map(({ id, displayName }) => [id, displayName])
    ),
    sites: new Map(
      (config?.promotionSites || []).map(({ id, name }) => [id, name])
    )
  };
}

function assignmentSourceLabel(value) {
  if (value === 'explicit') return '显式';
  if (value === 'weighted') return '加权轮询';
  if (value === 'default_blocked') return '默认 Pair（已拦截）';
  return value || '—';
}

function renderPlanTable(documentRef, draft) {
  const wrapper = documentRef.createElement('div');
  wrapper.className = 'batch-wizard__table-wrap';
  wrapper.tabIndex = 0;
  wrapper.setAttribute('aria-label', '批次分配预览，可横向滚动');
  const table = documentRef.createElement('table');
  table.className = 'batch-wizard__table';
  appendText(documentRef, table, 'caption', '逐行身份与推广网站分配预览', {
    class: 'sr-only'
  });
  const head = documentRef.createElement('thead');
  const headRow = documentRef.createElement('tr');
  for (const label of ['行', '目标', '身份', '推广网站', '分配', '状态', '操作']) {
    appendText(documentRef, headRow, 'th', label, { scope: 'col' });
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = documentRef.createElement('tbody');
  const labels = entityLabels(draft.domainConfig);
  for (const task of draft.plan.tasks) {
    const row = documentRef.createElement('tr');
    row.dataset.planRow = String(task.rowNumber);
    appendText(documentRef, row, 'th', String(task.rowNumber), { scope: 'row' });
    appendText(documentRef, row, 'td', task.targetUrl || '—');
    appendText(
      documentRef,
      row,
      'td',
      labels.profiles.get(task.profileId) || task.profileId || '—'
    );
    appendText(
      documentRef,
      row,
      'td',
      labels.sites.get(task.promotionSiteId) || task.promotionSiteId || '—'
    );
    appendText(documentRef, row, 'td', assignmentSourceLabel(task.assignmentSource));
    appendText(
      documentRef,
      row,
      'td',
      task.state === 'eligible' ? '可执行' : task.blockReason || '已拦截'
    );
    const action = documentRef.createElement('td');
    if (task.blockReason === 'recent_success' || task.recentSuccessOverride) {
      const button = appendText(
        documentRef,
        action,
        'button',
        task.recentSuccessOverride ? '撤销近期重复授权' : '本行仍然发送',
        {
          type: 'button',
          'data-action': 'toggle-repeat-override',
          'data-target-url': task.canonicalTargetUrl || task.targetUrl,
          'aria-pressed': String(task.recentSuccessOverride)
        }
      );
      button.className = 'batch-wizard__text-action';
    } else {
      appendText(documentRef, action, 'span', '—');
    }
    row.appendChild(action);
    body.appendChild(row);
  }
  table.appendChild(body);
  wrapper.appendChild(table);
  return wrapper;
}

function renderPlanPreview(documentRef, draft) {
  const summary = draft.planSummary || {
    status: {
      eligible: draft.plan.tasks.filter(({ state }) => state === 'eligible').length,
      blocked: draft.plan.tasks.filter(({ state }) => state !== 'eligible').length
    }
  };
  const fragment = documentRef.createDocumentFragment();
  appendText(
    documentRef,
    fragment,
    'p',
    `可执行 ${summary.status?.eligible || 0}；拦截 ${summary.status?.blocked || 0}。`
      + '同一批次重复 URL 永远不可覆盖。',
    { class: 'batch-wizard__summary', 'data-plan-summary': '', 'aria-live': 'polite' }
  );
  const quotas = draft.plan.quotas;
  appendText(
    documentRef,
    fragment,
    'p',
    `配额：批次 ${quotas.batch}；每身份 ${quotas.perProfile}；`
      + `每推广网站 ${quotas.perPromotionSite}；每目标域名 ${quotas.perTargetDomain}。`,
    { class: 'batch-wizard__summary', 'data-quota-summary': '' }
  );
  fragment.appendChild(renderPlanTable(documentRef, draft));
  return fragment;
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

  if (draft.domainConfig && draft.parsedCsv) {
    const mapping = documentRef.createElement('div');
    mapping.className = 'batch-wizard__settings-grid';
    mapping.dataset.columnMapping = '';
    mapping.append(
      mappingSelect(documentRef, draft.parsedCsv, draft.mapping, {
        label: '目标 URL 列',
        name: 'mappingTargetUrl',
        key: 'targetUrl',
        required: true
      }),
      mappingSelect(documentRef, draft.parsedCsv, draft.mapping, {
        label: '来源域名列',
        name: 'mappingSourceDomain',
        key: 'sourceDomain'
      }),
      mappingSelect(documentRef, draft.parsedCsv, draft.mapping, {
        label: 'Profile 列',
        name: 'mappingProfileRef',
        key: 'profileRef'
      }),
      mappingSelect(documentRef, draft.parsedCsv, draft.mapping, {
        label: 'Promotion Site 列',
        name: 'mappingPromotionSiteRef',
        key: 'promotionSiteRef'
      })
    );
    item.appendChild(mapping);
    if (draft.plan) item.appendChild(renderPlanPreview(documentRef, draft));
    return item;
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
  const entries = draft.plan
    ? [
        [
          '身份',
          String(Object.keys(draft.planSummary?.byProfile || {}).length || '—')
        ],
        [
          '推广网站',
          String(Object.keys(draft.planSummary?.byPromotionSite || {}).length || '—')
        ],
        [
          '处理行数',
          String(draft.planSummary?.status?.eligible || 0)
        ],
        ['并发', String(draft.settings.concurrency)],
        ['单项超时', `${draft.settings.timeoutSeconds} 秒`]
      ]
    : [
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
  if (draft.plan) {
    const confirm = documentRef.createElement('div');
    confirm.className = 'batch-wizard__toggles';
    confirm.appendChild(checkbox(documentRef, {
      label: '我已核对逐行目标、身份、推广网站和自动提交设置',
      name: 'normalConfirmed',
      checked: draft.confirmationChecks.normalConfirmed
    }));
    const riskLabels = {
      multiple_assignments: '本批次使用多身份或多推广网站',
      raised_quota: '本批次提高了配额',
      recent_success_override: '本批次授权向近期成功目标再次发送'
    };
    if (draft.plan.confirmationRequirements.length > 0) {
      const risks = documentRef.createElement('ul');
      risks.dataset.confirmationRisks = '';
      for (const risk of draft.plan.confirmationRequirements) {
        appendText(documentRef, risks, 'li', riskLabels[risk] || risk);
      }
      confirm.appendChild(risks);
      confirm.appendChild(checkbox(documentRef, {
        label: '我了解并确认以上高风险条件',
        name: 'highRiskConfirmed',
        checked: draft.confirmationChecks.highRiskConfirmed
      }));
    }
    item.appendChild(confirm);
  }
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
  if (step === 1) return draftAssignmentIsReady(draft);
  if (step === 2) {
    return draft.plan
      ? (draft.planSummary?.status?.eligible || 0) > 0
      : includedRunnableRows(draft.preflight).length > 0;
  }
  if (step === 3) return true;
  if (draft.plan) {
    const highRiskReady = draft.plan.confirmationRequirements.length === 0
      || draft.confirmationChecks.highRiskConfirmed;
    return draftAssignmentIsReady(draft)
      && (draft.planSummary?.status?.eligible || 0) > 0
      && draft.confirmationChecks.normalConfirmed
      && highRiskReady
      && draft.confirmation?.planFingerprint === draft.plan.planFingerprint
      && !readinessError;
  }
  return draftAssignmentIsReady(draft)
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
    if (action === 'toggle-repeat-override') {
      const targetUrl = sanitizeBatchUrl(actionTarget.dataset.targetUrl);
      if (!targetUrl) return;
      const included = actionTarget.getAttribute('aria-pressed') !== 'true';
      handlers.onRepeatOverride?.(targetUrl, included, cloneDraft(draft));
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
    const mappingNames = {
      mappingTargetUrl: 'targetUrl',
      mappingSourceDomain: 'sourceDomain',
      mappingProfileRef: 'profileRef',
      mappingPromotionSiteRef: 'promotionSiteRef'
    };
    if (mappingNames[input.name]) {
      const mapping = {
        ...(draft.mapping || {
          targetUrl: null,
          sourceDomain: null,
          profileRef: null,
          promotionSiteRef: null
        }),
        [mappingNames[input.name]]: input.value === '' ? null : Number(input.value)
      };
      draft = normalizeDraft({
        ...draft,
        mapping,
        plan: null,
        planSummary: null,
        confirmation: null,
        confirmationChecks: {
          normalConfirmed: false,
          highRiskConfirmed: false
        }
      });
      emitDraftChange();
      handlers.onMappingChange?.(mapping, cloneDraft(draft));
      return;
    }
    if (input.name === 'normalConfirmed' || input.name === 'highRiskConfirmed') {
      const confirmationChecks = {
        ...draft.confirmationChecks,
        [input.name]: input.checked
      };
      draft = normalizeDraft({
        ...draft,
        confirmationChecks,
        confirmation: null
      });
      emitDraftChange();
      handlers.onConfirmationChange?.(confirmationChecks, cloneDraft(draft));
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
