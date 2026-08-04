const DEFAULT_WRITABLE_CONTROL_IDS = Object.freeze([
  'newProfileBtn',
  'saveProfileBtn',
  'clearPasswordBtn',
  'deleteProfileBtn',
  'newPromotionSiteBtn',
  'savePromotionSiteBtn',
  'deletePromotionSiteBtn',
  'newPairBtn',
  'savePairBtn',
  'deletePairBtn',
  'savePolicyBtn',
  'saveLlmConfigBtn',
  'testLlmConnectionBtn',
  'exportConfigBtn',
  'importConfigBtn',
  'applyImportConfigBtn',
  'toggleExportOutlinksFloatingBtn',
  'cloudSyncCreateBtn',
  'cloudSyncImportBtn',
  'cloudSyncCopyBtn',
  'cloudSyncRunBtn',
  'cloudSyncDisconnectBtn',
  'cloudSyncDeleteBtn'
]);

const STABLE_ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_:-]{0,95}$/;
const OPTIONS_ERROR_MESSAGES = Object.freeze({
  missing_profile_fields: '请填写身份显示名、姓名和邮箱。',
  invalid_profile: '身份配置不完整，请检查后重试。',
  invalid_profile_id: '身份标识无效，请新建身份后重试。',
  invalid_profile_email: '邮箱格式无效，请检查后重试。',
  duplicate_profile_id: '身份 ID 重复，请重新选择配置。',
  duplicate_profile_display_name: '身份显示名已存在，请使用其他名称。',
  profile_not_found: '找不到该身份，请刷新设置后重试。',
  profile_in_use: '该身份配置正在被分配组合使用，请先调整组合。',
  invalid_profile_password: '密码格式无效，请重新输入。',
  invalid_promotion_site: '推广网站配置不完整，请检查后重试。',
  invalid_promotion_site_id: '推广网站标识无效，请新建网站后重试。',
  invalid_promotion_site_url: '推广网站链接无效，请填写 HTTP 或 HTTPS 地址。',
  duplicate_promotion_site_id: '推广网站 ID 重复，请重新选择配置。',
  duplicate_promotion_site_name: '推广网站名称已存在，请使用其他名称。',
  promotion_site_not_found: '找不到该推广网站，请刷新设置后重试。',
  promotion_site_in_use: '该推广网站正在被分配组合使用，请先调整组合。',
  invalid_assignment_pair: '身份与推广网站组合无效，请检查后重试。',
  invalid_assignment_pair_weight: '组合权重必须是正整数。',
  duplicate_assignment_pair_id: '分配组合 ID 重复，请重新选择配置。',
  duplicate_assignment_combination: '该身份与推广网站组合已经存在。',
  assignment_pair_not_found: '找不到该分配组合，请刷新设置后重试。',
  invalid_default_assignment_pair: '默认分配组合无效，请重新选择。',
  invalid_assignment_policy: '分配策略无效，请检查后重试。',
  invalid_quotas: '批次配额必须是正整数。',
  invalid_quota_batch: '批次上限必须是正整数。',
  invalid_quota_profile: '每个身份的上限必须是正整数。',
  invalid_quota_promotion_site: '每个推广网站的上限必须是正整数。',
  invalid_quota_target_domain: '每个目标域名的上限必须是正整数。',
  stale_domain_config_revision: '配置已在其他页面更新，请刷新后重试。',
  unsupported_domain_config_version: '当前配置版本不受支持，请更新扩展。',
  invalid_domain_config: '身份与推广网站配置无效，请检查后重试。',
  invalid_domain_config_revision: '配置版本信息无效，请刷新后重试。',
  invalid_domain_config_storage: '配置存储暂时不可用，请稍后重试。',
  invalid_domain_config_repository_response:
    '配置服务返回了无效响应，请稍后重试。',
  invalid_domain_config_repository_runtime:
    '配置服务暂时不可用，请重新加载扩展后重试。',
  invalid_domain_config_repository_request:
    '配置请求无效，请重新加载页面后重试。',
  domain_config_repository_request_failed:
    '配置服务暂时不可用，请稍后重试。',
  profile_secret_request_failed: '本机密码服务暂时不可用，请稍后重试。',
  invalid_profile_secret_response:
    '本机密码服务返回了无效响应，请稍后重试。',
  invalid_profile_secret_runtime:
    '本机密码服务暂时不可用，请重新加载扩展后重试。',
  sensitive_field_forbidden: '配置包含敏感字段，已阻止导入。',
  invalid_config_bundle_json: 'JSON 格式无效，请选择有效的配置文件。',
  invalid_config_bundle_format: '配置文件格式无效，请选择受支持的配置包。',
  unsupported_config_bundle_version: '配置文件版本不受支持，请更新扩展。',
  sensitive_config_bundle_field: '配置文件包含敏感字段，已阻止导入。',
  sensitive_config_bundle_url: '配置文件包含敏感 URL 参数，已阻止导入。',
  invalid_config_bundle_llm: '模型公开配置无效，请检查后重试。',
  invalid_config_bundle_batch_defaults: '批处理默认设置无效，请检查后重试。',
  invalid_config_bundle_preferences: '界面偏好设置无效，请检查后重试。',
  stale_config_bundle_preview: '导入预览已过期，请重新选择文件。',
  config_bundle_apply_failed: '配置应用失败，原有设置已恢复，请重试。',
  config_bundle_rollback_failed:
    '配置应用和恢复均失败，请重新加载页面并检查当前设置。',
  PERMISSION_DENIED: '未授予模型 API 域名访问权限。',
  PERMISSION_UNAVAILABLE: '模型 API 权限服务暂时不可用，请稍后重试。',
  INVALID_API_URL: 'API Base URL 格式无效，请检查后重试。',
  MISSING_MODEL: '请填写模型 ID。',
  MISSING_API_KEY: '请填写 API Key。',
  INVALID_API_KEY: 'API Key 无效，请检查后重试。',
  UPSTREAM_ERROR: '模型服务请求失败，请稍后重试。',
  UNKNOWN_ERROR: '模型服务暂时不可用，请稍后重试。'
});

export function stableOptionsErrorCode(
  error,
  fallback = 'options_operation_failed'
) {
  const candidate = typeof error?.code === 'string'
    ? error.code
    : '';
  return (
    STABLE_ERROR_CODE_PATTERN.test(candidate)
    && Object.hasOwn(OPTIONS_ERROR_MESSAGES, candidate)
  )
    ? candidate
    : fallback;
}

export function optionsErrorMessage(
  error,
  fallback = '操作失败，请稍后重试。'
) {
  return OPTIONS_ERROR_MESSAGES[stableOptionsErrorCode(error)] || fallback;
}

function setWritableControlsDisabled(
  documentRef,
  writableControlIds,
  disabled
) {
  for (const id of writableControlIds) {
    const control = documentRef?.getElementById?.(id);
    if (control) control.disabled = disabled;
  }
}

function retryButtonFor(documentRef) {
  let button = documentRef?.getElementById?.('retryOptionsLoadBtn');
  if (button || !documentRef?.createElement) return button;
  const status = documentRef.getElementById?.('settingsStatus');
  if (!status?.parentNode) return null;
  button = documentRef.createElement('button');
  button.id = 'retryOptionsLoadBtn';
  button.type = 'button';
  button.hidden = true;
  button.textContent = '重试加载';
  status.insertAdjacentElement('afterend', button);
  return button;
}

export function renderOptionsBootFailure(
  documentRef,
  writableControlIds = DEFAULT_WRITABLE_CONTROL_IDS
) {
  const status = documentRef?.getElementById?.('settingsStatus');
  if (status) {
    status.textContent = '设置加载失败，请检查扩展状态后重试。';
    status.style.color = '#dc2626';
    status.classList.add('visible');
  }
  setWritableControlsDisabled(documentRef, writableControlIds, true);
  const retryButton = retryButtonFor(documentRef);
  if (retryButton) {
    retryButton.hidden = false;
    retryButton.disabled = false;
  }
}

function renderOptionsBootSuccess(documentRef) {
  const status = documentRef?.getElementById?.('settingsStatus');
  if (status) {
    status.textContent = '设置已加载。';
    status.style.color = '#059669';
    status.classList.add('visible');
  }
  const retryButton = retryButtonFor(documentRef);
  if (retryButton) {
    retryButton.hidden = true;
    retryButton.disabled = false;
  }
}

export function installOptionsPageBoot({
  document: documentRef,
  boot,
  writableControlIds = DEFAULT_WRITABLE_CONTROL_IDS,
  reportError = (code) => {
    console.error('[options] boot failed:', code);
  }
} = {}) {
  if (!documentRef || typeof boot !== 'function') {
    throw new TypeError('document and boot are required');
  }
  const retryButton = retryButtonFor(documentRef);
  let failed = false;
  let inFlight = false;

  async function runBoot() {
    if (inFlight) return false;
    inFlight = true;
    if (retryButton) retryButton.disabled = true;
    if (failed) {
      setWritableControlsDisabled(documentRef, writableControlIds, false);
    }
    const status = documentRef.getElementById('settingsStatus');
    if (status) {
      status.textContent = failed ? '正在重新加载设置…' : '设置加载中…';
      status.style.color = '';
      status.classList.add('visible');
    }
    try {
      await boot();
      failed = false;
      renderOptionsBootSuccess(documentRef);
      return true;
    } catch (error) {
      failed = true;
      renderOptionsBootFailure(documentRef, writableControlIds);
      try {
        reportError(stableOptionsErrorCode(error, 'options_boot_failed'));
      } catch (_) {
        // Diagnostics must not prevent the retry control from becoming usable.
      }
      return false;
    } finally {
      inFlight = false;
      if (retryButton) retryButton.disabled = false;
    }
  }

  const handleRetry = () => {
    void runBoot();
  };
  retryButton?.addEventListener('click', handleRetry);
  documentRef.addEventListener('DOMContentLoaded', () => {
    void runBoot();
  }, { once: true });

  return Object.freeze({
    retry: runBoot,
    destroy() {
      retryButton?.removeEventListener('click', handleRetry);
    }
  });
}

export function bindSafeTabNavigation({
  button,
  open,
  onError = () => {},
  reportError = (code) => {
    console.error('[options] tab navigation failed:', code);
  }
} = {}) {
  if (!button || typeof open !== 'function') {
    throw new TypeError('button and open are required');
  }
  let inFlight = false;

  async function navigate() {
    if (inFlight) return false;
    inFlight = true;
    button.disabled = true;
    try {
      await open();
      return true;
    } catch (error) {
      const code = stableOptionsErrorCode(
        error,
        'options_tab_navigation_failed'
      );
      try {
        reportError(code);
      } catch (_) {
        // Diagnostics are best effort.
      }
      try {
        onError(code);
      } catch (_) {
        // The navigation failure is already contained and remains retryable.
      }
      return false;
    } finally {
      inFlight = false;
      button.disabled = false;
    }
  }

  const handleClick = () => {
    void navigate();
  };
  button.addEventListener('click', handleClick);

  return Object.freeze({
    navigate,
    destroy() {
      button.removeEventListener('click', handleClick);
    }
  });
}

export function bindStoredBooleanToggle({
  button,
  initialValue,
  write,
  render,
  onCommit = () => {},
  onError = () => {}
} = {}) {
  if (
    !button
    || typeof write !== 'function'
    || typeof render !== 'function'
  ) {
    throw new TypeError('button, write, and render are required');
  }
  let value = initialValue === true;
  let inFlight = false;

  function setValue(nextValue) {
    value = nextValue === true;
    button.setAttribute('aria-pressed', String(value));
    render(value);
  }

  async function toggle() {
    if (inFlight) return false;
    inFlight = true;
    button.disabled = true;
    const nextValue = !value;
    try {
      await write(nextValue);
      setValue(nextValue);
      onCommit(nextValue);
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      inFlight = false;
      button.disabled = false;
    }
  }

  button.addEventListener('click', () => {
    void toggle();
  });
  setValue(value);

  return Object.freeze({
    get value() {
      return value;
    },
    setValue,
    toggle
  });
}
