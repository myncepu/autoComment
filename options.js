import {
  DEFAULT_LLM_CONFIG,
  LLM_SYNC_KEYS,
  loadLlmConfig
} from './lib/llm-config.mjs';
import { saveOptionsModelConfig, testOptionsModelConfig } from './lib/llm-options-controller.mjs';
import { bootAppShell } from './lib/app-shell.mjs';
import { focusOptionsSection } from './lib/options-section-navigation.mjs';

const LEGACY_SKILL_TEMPLATE_STORAGE_KEY = 'qwen_skill_template';
const WEBSITE_URL_STORAGE_KEY = 'promotion_website_url';
const WEBSITE_CONTENT_STORAGE_KEY = 'promotion_website_content';
const USER_NAME_STORAGE_KEY = 'auto_fill_user_name';
const USER_EMAIL_STORAGE_KEY = 'auto_fill_user_email';
const USER_PASSWORD_STORAGE_KEY = 'auto_fill_user_password';
const LEGACY_PROMPT_FIELD_VALUES_STORAGE_KEY = 'auto_fill_prompt_field_values';
const SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY = 'show_export_outlinks_floating_button';
const CONFIG_VERSION = 3;

const ACTIVE_STORAGE_KEYS = [
  WEBSITE_URL_STORAGE_KEY,
  WEBSITE_CONTENT_STORAGE_KEY,
  USER_NAME_STORAGE_KEY,
  USER_EMAIL_STORAGE_KEY,
  USER_PASSWORD_STORAGE_KEY,
  LLM_SYNC_KEYS.apiBaseUrl,
  LLM_SYNC_KEYS.model,
  SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY
];

const IMPORT_COMPAT_STORAGE_KEYS = [
  ...ACTIVE_STORAGE_KEYS,
  LEGACY_SKILL_TEMPLATE_STORAGE_KEY,
  LEGACY_PROMPT_FIELD_VALUES_STORAGE_KEY
];

const modelDependencies = {
  storage: chrome.storage,
  permissions: chrome.permissions,
  runtime: chrome.runtime
};

document.addEventListener('DOMContentLoaded', async () => {
  bootAppShell(document, { currentUrl: window.location.href });
  const focusCurrentSection = () => focusOptionsSection(document, window.location.hash);
  focusCurrentSection();
  window.addEventListener('hashchange', focusCurrentSection);

  const websiteUrlInput = document.getElementById('websiteUrl');
  const websiteContentInput = document.getElementById('websiteContent');
  const userNameInput = document.getElementById('userName');
  const userEmailInput = document.getElementById('userEmail');
  const userPasswordInput = document.getElementById('userPassword');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const settingsStatusEl = document.getElementById('settingsStatus');
  const llmApiBaseUrlInput = document.getElementById('llmApiBaseUrl');
  const llmApiKeyInput = document.getElementById('llmApiKey');
  const llmModelInput = document.getElementById('llmModel');
  const saveLlmConfigBtn = document.getElementById('saveLlmConfigBtn');
  const testLlmConnectionBtn = document.getElementById('testLlmConnectionBtn');
  const llmStatusEl = document.getElementById('llmStatus');
  const exportConfigBtn = document.getElementById('exportConfigBtn');
  const importConfigBtn = document.getElementById('importConfigBtn');
  const importConfigFileInput = document.getElementById('importConfigFileInput');
  const importExportStatus = document.getElementById('importExportStatus');
  const openBatchBtn = document.getElementById('openBatchBtn');
  const openHistoryBtn = document.getElementById('openHistoryBtn');
  const toggleExportOutlinksFloatingBtn = document.getElementById('toggleExportOutlinksFloatingBtn');

  if (
    !websiteUrlInput ||
    !websiteContentInput ||
    !userNameInput ||
    !userEmailInput ||
    !userPasswordInput ||
    !saveSettingsBtn ||
    !settingsStatusEl ||
    !llmApiBaseUrlInput ||
    !llmApiKeyInput ||
    !llmModelInput ||
    !saveLlmConfigBtn ||
    !testLlmConnectionBtn ||
    !llmStatusEl
  ) {
    console.error('Options page 初始化失败：元素未找到');
    return;
  }

  function showStatus(el, text, timeout = 1600) {
    if (!el) return;
    el.textContent = text;
    el.style.opacity = '1';
    setTimeout(() => {
      el.style.opacity = '0';
    }, timeout);
  }

  let showExportOutlinksFloatingButton = true;

  function renderExportOutlinksFloatingToggle() {
    if (!toggleExportOutlinksFloatingBtn) return;
    toggleExportOutlinksFloatingBtn.textContent = showExportOutlinksFloatingButton ? '隐藏导出外链按钮' : '显示导出外链按钮';
    toggleExportOutlinksFloatingBtn.classList.toggle('btn-primary', !showExportOutlinksFloatingButton);
    toggleExportOutlinksFloatingBtn.classList.toggle('btn-secondary', showExportOutlinksFloatingButton);
    toggleExportOutlinksFloatingBtn.title = showExportOutlinksFloatingButton
      ? '点击后页面不再显示“导出外链”浮动按钮'
      : '点击后页面显示“导出外链”浮动按钮';
  }

  function pickLegacyPromptValue(values, keywords) {
    if (!values || typeof values !== 'object') return '';
    const normalizedKeywords = keywords.map((keyword) => String(keyword).toLowerCase());
    const entry = Object.entries(values).find(([key, value]) => {
      if (!value) return false;
      const normalizedKey = String(key || '').toLowerCase();
      return normalizedKeywords.some((keyword) => normalizedKey.includes(keyword));
    });
    return entry ? String(entry[1] || '').trim() : '';
  }

  function getLegacyWebsiteUrl(data) {
    return pickLegacyPromptValue(data[LEGACY_PROMPT_FIELD_VALUES_STORAGE_KEY], [
      '网站链接',
      '网址',
      'website link',
      'website url',
      'url'
    ]);
  }

  function getLegacyWebsiteContent(data) {
    return pickLegacyPromptValue(data[LEGACY_PROMPT_FIELD_VALUES_STORAGE_KEY], [
      '网站内容',
      '网站介绍',
      'website content',
      'site content',
      'description'
    ]);
  }

  function getInputValue(input) {
    return input && typeof input.value === 'string' ? input.value.trim() : '';
  }

  function mergeCurrentFormValues(data) {
    const merged = { ...(data || {}) };
    const currentValues = {
      [WEBSITE_URL_STORAGE_KEY]: getInputValue(websiteUrlInput),
      [WEBSITE_CONTENT_STORAGE_KEY]: getInputValue(websiteContentInput),
      [USER_NAME_STORAGE_KEY]: getInputValue(userNameInput),
      [USER_EMAIL_STORAGE_KEY]: getInputValue(userEmailInput),
      [USER_PASSWORD_STORAGE_KEY]: getInputValue(userPasswordInput),
      [LLM_SYNC_KEYS.apiBaseUrl]: getInputValue(llmApiBaseUrlInput),
      [LLM_SYNC_KEYS.model]: getInputValue(llmModelInput)
    };

    ACTIVE_STORAGE_KEYS.forEach((key) => {
      if (currentValues[key] !== '') {
        merged[key] = currentValues[key];
      }
    });

    return merged;
  }

  function getImportedData(config) {
    if (!config || typeof config !== 'object') return null;
    if (config.data && typeof config.data === 'object') return config.data;
    return config;
  }

  function normalizeStringSetting(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
  }

  function getSettingsPayloadFromInputs() {
    return {
      [WEBSITE_URL_STORAGE_KEY]: normalizeStringSetting(websiteUrlInput.value),
      [WEBSITE_CONTENT_STORAGE_KEY]: normalizeStringSetting(websiteContentInput.value),
      [USER_NAME_STORAGE_KEY]: normalizeStringSetting(userNameInput.value),
      [USER_EMAIL_STORAGE_KEY]: normalizeStringSetting(userEmailInput.value),
      [USER_PASSWORD_STORAGE_KEY]: normalizeStringSetting(userPasswordInput.value)
    };
  }

  function applySettingsToForm(data) {
    if (!data || typeof data !== 'object') return;
    if (data[WEBSITE_URL_STORAGE_KEY] !== undefined) websiteUrlInput.value = normalizeStringSetting(data[WEBSITE_URL_STORAGE_KEY]);
    if (data[WEBSITE_CONTENT_STORAGE_KEY] !== undefined) websiteContentInput.value = normalizeStringSetting(data[WEBSITE_CONTENT_STORAGE_KEY]);
    if (data[USER_NAME_STORAGE_KEY] !== undefined) userNameInput.value = normalizeStringSetting(data[USER_NAME_STORAGE_KEY]);
    if (data[USER_EMAIL_STORAGE_KEY] !== undefined) userEmailInput.value = normalizeStringSetting(data[USER_EMAIL_STORAGE_KEY]);
    if (data[USER_PASSWORD_STORAGE_KEY] !== undefined) userPasswordInput.value = normalizeStringSetting(data[USER_PASSWORD_STORAGE_KEY]);
    if (data[LLM_SYNC_KEYS.apiBaseUrl] !== undefined) llmApiBaseUrlInput.value = normalizeStringSetting(data[LLM_SYNC_KEYS.apiBaseUrl]);
    if (data[LLM_SYNC_KEYS.model] !== undefined) llmModelInput.value = normalizeStringSetting(data[LLM_SYNC_KEYS.model]);
    if (data[SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY] !== undefined) {
      showExportOutlinksFloatingButton = data[SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY] !== false;
      renderExportOutlinksFloatingToggle();
    }
  }

  function buildImportPayload(importedData) {
    const toSave = {};
    IMPORT_COMPAT_STORAGE_KEYS.forEach((key) => {
      if (importedData[key] !== undefined) toSave[key] = importedData[key];
    });
    [
      WEBSITE_URL_STORAGE_KEY,
      WEBSITE_CONTENT_STORAGE_KEY,
      USER_NAME_STORAGE_KEY,
      USER_EMAIL_STORAGE_KEY,
      USER_PASSWORD_STORAGE_KEY,
      LLM_SYNC_KEYS.apiBaseUrl,
      LLM_SYNC_KEYS.model
    ].forEach((key) => {
      if (importedData[key] !== undefined) toSave[key] = normalizeStringSetting(importedData[key]);
    });
    if (!toSave[WEBSITE_URL_STORAGE_KEY]) {
      const legacyWebsiteUrl = getLegacyWebsiteUrl(importedData);
      if (legacyWebsiteUrl) toSave[WEBSITE_URL_STORAGE_KEY] = legacyWebsiteUrl;
    }
    if (!toSave[WEBSITE_CONTENT_STORAGE_KEY]) {
      const legacyWebsiteContent = getLegacyWebsiteContent(importedData);
      if (legacyWebsiteContent) toSave[WEBSITE_CONTENT_STORAGE_KEY] = legacyWebsiteContent;
    }
    if (importedData[SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY] !== undefined) {
      toSave[SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY] =
        importedData[SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY] !== false;
    }
    return toSave;
  }

  function loadSettings() {
    chrome.storage.sync.get(IMPORT_COMPAT_STORAGE_KEYS, (result) => {
      if (chrome.runtime.lastError) {
        console.error('读取设置失败：', chrome.runtime.lastError);
        return;
      }
      const data = result || {};
      websiteUrlInput.value = typeof data[WEBSITE_URL_STORAGE_KEY] === 'string'
        ? data[WEBSITE_URL_STORAGE_KEY]
        : getLegacyWebsiteUrl(data);
      websiteContentInput.value = typeof data[WEBSITE_CONTENT_STORAGE_KEY] === 'string'
        ? data[WEBSITE_CONTENT_STORAGE_KEY]
        : getLegacyWebsiteContent(data);
      userNameInput.value = typeof data[USER_NAME_STORAGE_KEY] === 'string' ? data[USER_NAME_STORAGE_KEY] : '';
      userEmailInput.value = typeof data[USER_EMAIL_STORAGE_KEY] === 'string' ? data[USER_EMAIL_STORAGE_KEY] : '';
      userPasswordInput.value = typeof data[USER_PASSWORD_STORAGE_KEY] === 'string' ? data[USER_PASSWORD_STORAGE_KEY] : '';
      showExportOutlinksFloatingButton = data[SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY] !== false;
      renderExportOutlinksFloatingToggle();
    });
  }

  const requiredSettingsFields = [
    { el: websiteUrlInput, label: '网站链接' },
    { el: websiteContentInput, label: '网站内容' },
    { el: userNameInput, label: '姓名/昵称' },
    { el: userEmailInput, label: '邮箱' }
  ];

  function validateRequiredSettings() {
    let firstInvalid = null;
    const missingLabels = [];
    requiredSettingsFields.forEach(({ el, label }) => {
      const isValid = el.checkValidity() && !!el.value.trim();
      el.classList.toggle('is-invalid', !isValid);
      if (!isValid) {
        missingLabels.push(label);
        if (!firstInvalid) firstInvalid = el;
      }
    });
    if (firstInvalid) {
      firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      firstInvalid.focus();
      showStatus(settingsStatusEl, `请先填写必填项：${missingLabels.join('、')}`, 2600);
      return false;
    }
    return true;
  }

  function showImportExportStatus(text, isError) {
    if (!importExportStatus) return;
    importExportStatus.textContent = text;
    importExportStatus.style.color = isError ? '#dc2626' : '#b45309';
    importExportStatus.style.opacity = '1';
    setTimeout(() => {
      importExportStatus.style.opacity = '0';
    }, 3000);
  }

  requiredSettingsFields.forEach(({ el }) => {
    el.addEventListener('input', () => {
      el.classList.toggle('is-invalid', !(el.checkValidity() && !!el.value.trim()));
    });
  });

  saveLlmConfigBtn.addEventListener('click', async () => {
    try {
      await saveOptionsModelConfig(modelDependencies, {
        apiBaseUrl: llmApiBaseUrlInput.value,
        apiKey: llmApiKeyInput.value,
        model: llmModelInput.value
      });
      showStatus(llmStatusEl, '模型配置已保存');
    } catch (error) {
      showStatus(llmStatusEl, error.message || '模型配置保存失败', 3000);
    }
  });

  testLlmConnectionBtn.addEventListener('click', async () => {
    testLlmConnectionBtn.disabled = true;
    showStatus(llmStatusEl, '正在真实调用模型…', 60000);
    try {
      const text = await testOptionsModelConfig(modelDependencies, {
        apiBaseUrl: llmApiBaseUrlInput.value,
        apiKey: llmApiKeyInput.value,
        model: llmModelInput.value
      });
      showStatus(llmStatusEl, `连接成功：${text}`, 5000);
    } catch (error) {
      showStatus(llmStatusEl, error.message || '连接测试失败', 5000);
    } finally {
      testLlmConnectionBtn.disabled = false;
    }
  });

  saveSettingsBtn.addEventListener('click', () => {
    if (!validateRequiredSettings()) return;
    chrome.storage.sync.set(getSettingsPayloadFromInputs(), () => {
      if (chrome.runtime.lastError) {
        console.error('保存设置失败：', chrome.runtime.lastError);
        showStatus(settingsStatusEl, '保存失败', 2000);
        return;
      }
      showStatus(settingsStatusEl, '已保存');
    });
  });

  if (toggleExportOutlinksFloatingBtn) {
    renderExportOutlinksFloatingToggle();
    toggleExportOutlinksFloatingBtn.addEventListener('click', () => {
      const nextValue = !showExportOutlinksFloatingButton;
      chrome.storage.sync.set({ [SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY]: nextValue }, () => {
        if (chrome.runtime.lastError) {
          console.error('保存导出外链浮动按钮设置失败：', chrome.runtime.lastError);
          showStatus(settingsStatusEl, '保存失败', 2000);
          return;
        }
        showExportOutlinksFloatingButton = nextValue;
        renderExportOutlinksFloatingToggle();
        showStatus(settingsStatusEl, nextValue ? '已显示导出外链按钮' : '已隐藏导出外链按钮');
      });
    });
  }

  if (exportConfigBtn) {
    exportConfigBtn.addEventListener('click', () => {
      chrome.storage.sync.get(ACTIVE_STORAGE_KEYS, (result) => {
        if (chrome.runtime.lastError) {
          showImportExportStatus('导出失败：' + chrome.runtime.lastError.message, true);
          return;
        }
        const mergedData = mergeCurrentFormValues(result);
        const config = { _version: CONFIG_VERSION, _exportTime: new Date().toISOString(), data: {} };
        ACTIVE_STORAGE_KEYS.forEach((key) => {
          if (mergedData[key] !== undefined) config.data[key] = mergedData[key];
        });
        if (!config.data[WEBSITE_CONTENT_STORAGE_KEY]) {
          showImportExportStatus('导出失败：请先填写你的网站内容。', true);
          return;
        }
        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'autocomment-config-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showImportExportStatus('配置已导出！', false);
      });
    });
  }

  if (importConfigBtn && importConfigFileInput) {
    importConfigBtn.addEventListener('click', () => importConfigFileInput.click());
    importConfigFileInput.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (loadEvent) => {
        try {
          const importedData = getImportedData(JSON.parse(loadEvent.target.result));
          if (!importedData) {
            showImportExportStatus('文件格式无效，不是有效的配置文件。', true);
            return;
          }
          const toSave = buildImportPayload(importedData);
          applySettingsToForm(toSave);
          if (!validateRequiredSettings()) {
            showImportExportStatus('导入失败：配置缺少网站链接、网站内容、姓名或邮箱。', true);
            return;
          }
          chrome.storage.sync.set(toSave, () => {
            if (chrome.runtime.lastError) {
              showImportExportStatus('导入失败：' + chrome.runtime.lastError.message, true);
              return;
            }
            showStatus(settingsStatusEl, '已保存');
            showImportExportStatus('配置已导入并保存！页面将自动刷新...', false);
            setTimeout(() => location.reload(), 1500);
          });
        } catch (error) {
          showImportExportStatus('解析文件失败：' + error.message, true);
        }
      };
      reader.readAsText(file);
      importConfigFileInput.value = '';
    });
  }

  if (openBatchBtn) {
    openBatchBtn.addEventListener('click', () => chrome.tabs.create({ url: 'batch.html' }));
  }
  if (openHistoryBtn) {
    openHistoryBtn.addEventListener('click', () => chrome.tabs.create({ url: 'history.html' }));
  }

  const modelConfig = await loadLlmConfig(chrome.storage);
  llmApiBaseUrlInput.value = modelConfig.apiBaseUrl || DEFAULT_LLM_CONFIG.apiBaseUrl;
  llmModelInput.value = modelConfig.model || DEFAULT_LLM_CONFIG.model;
  llmApiKeyInput.value = modelConfig.apiKey;
  loadSettings();
});
