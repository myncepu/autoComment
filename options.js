import {
  DEFAULT_LLM_CONFIG,
  loadLlmConfig
} from './lib/llm-config.mjs';
import {
  saveOptionsModelConfig,
  testOptionsModelConfig
} from './lib/llm-options-controller.mjs';
import {
  createCloudSyncOptionsController
} from './lib/cloud-sync-options-controller.mjs';
import { bootAppShell } from './lib/app-shell.mjs';
import { focusOptionsSection } from './lib/options-section-navigation.mjs';
import {
  createDomainConfigRepositoryClient
} from './lib/domain-config-repository-message.mjs';
import {
  createProfileSecretClient
} from './lib/profile-secret-message-listener.mjs';
import {
  createDomainConfigOptionsController
} from './lib/domain-config-options-controller.mjs';
import {
  createOptionsConfigBundleController
} from './lib/options-config-bundle-controller.mjs';
import {
  createSafeOptionsSettingsAdapter
} from './lib/options-safe-settings-adapter.mjs';
import {
  createOptionsConfigBundleView
} from './lib/options-config-bundle-view.mjs';
import {
  LOCAL_DEBUG_BRIDGE_ORIGIN,
  LOCAL_DEBUG_BRIDGE_STORAGE_KEY
} from './lib/local-debug-bridge.mjs';
import {
  bindSafeTabNavigation,
  bindStoredBooleanToggle,
  installOptionsPageBoot,
  optionsErrorMessage,
  stableOptionsErrorCode
} from './lib/options-page-reliability.mjs';
import {
  identityGenerationRequest,
  parseGeneratedIdentities,
  parseGeneratedPromotionAnalysis,
  parseGeneratedPromotionPrompt,
  promotionEmailForUrl,
  promotionPageAnalysisRequest,
  promotionPageOriginPattern,
  promotionPromptGenerationRequest
} from './lib/options-ai-generator.mjs';

const SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY =
  'show_export_outlinks_floating_button';
const OUTLINK_EXPORT_FILTER_RULES_STORAGE_KEY = 'outlink_export_filter_rules';
const OUTLINK_EXPORT_HIDDEN_HOSTS_STORAGE_KEY = 'outlink_export_hidden_hosts';

function element(id) {
  return document.getElementById(id);
}

function generatedId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function codedOptionsError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function positiveInteger(input, code) {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 1) {
    throw codedOptionsError(code);
  }
  return value;
}

function reportOptionsDiagnostic(area, error, fallbackCode) {
  console.error(
    `[options] ${area}:`,
    stableOptionsErrorCode(error, fallbackCode)
  );
}

function downloadJson(value, fileName) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: 'application/json'
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function bootOptionsPage() {
  const ui = Object.fromEntries([
    'profileSelect',
    'newProfileBtn',
    'profileDisplayName',
    'userName',
    'userEmail',
    'userPassword',
    'passwordConfiguredStatus',
    'saveProfileBtn',
    'clearPasswordBtn',
    'deleteProfileBtn',
    'identityGenerateCount',
    'generateIdentitiesBtn',
    'saveGeneratedIdentitiesBtn',
    'identityGeneratorStatus',
    'generatedIdentityPreview',
    'promotionSiteSelect',
    'newPromotionSiteBtn',
    'promotionSiteName',
    'websiteEmail',
    'websiteUrl',
    'promotionPageKeywords',
    'websiteContent',
    'analyzePromotionPageBtn',
    'promotionAnalysisStatus',
    'generatePromotionPromptBtn',
    'promotionSiteEnabled',
    'savePromotionSiteBtn',
    'deletePromotionSiteBtn',
    'pairSelect',
    'newPairBtn',
    'pairProfileSelect',
    'pairPromotionSiteSelect',
    'pairWeight',
    'pairEnabled',
    'savePairBtn',
    'deletePairBtn',
    'defaultPairSelect',
    'quotaBatch',
    'quotaProfile',
    'quotaPromotionSite',
    'quotaTargetDomain',
    'savePolicyBtn',
    'settingsStatus',
    'llmApiBaseUrl',
    'llmApiKey',
    'llmModel',
    'saveLlmConfigBtn',
    'testLlmConnectionBtn',
    'llmStatus',
    'exportConfigBtn',
    'importConfigBtn',
    'importConfigFileInput',
    'applyImportConfigBtn',
    'importExportStatus',
    'importPreviewSummary',
    'openBatchBtn',
    'openHistoryBtn',
    'toggleExportOutlinksFloatingBtn',
    'outlinkExcludedDomains',
    'outlinkExcludedKeywords',
    'outlinkHiddenHosts',
    'saveOutlinkSettingsBtn',
    'openOutlinkTableBtn',
    'outlinkSettingsStatus',
    'localDebugStatus',
    'toggleLocalDebugBtn',
    'openLocalDebugBtn'
  ].map((id) => [id, element(id)]));
  if (Object.values(ui).some((value) => !value)) {
    console.error('[options] Required options controls are missing');
    return;
  }

  function showStatus(target, text, isError = false, timeout = 2600) {
    target.textContent = text;
    target.style.color = isError ? '#dc2626' : '#059669';
    target.classList.add('visible');
    setTimeout(() => target.classList.remove('visible'), timeout);
  }

  const configRepository = createDomainConfigRepositoryClient(chrome.runtime);
  const secretRepository = createProfileSecretClient(chrome.runtime);
  const domainController = createDomainConfigOptionsController({
    configRepository,
    secretRepository
  });
  const safeSettingsAdapter =
    createSafeOptionsSettingsAdapter(chrome.storage.sync, {
      permissions: chrome.permissions
    });
  const bundleController = createOptionsConfigBundleController({
    configRepository,
    domainController,
    settingsAdapter: safeSettingsAdapter
  });
  let snapshot = await domainController.snapshot();
  const legacyProfileEmail = snapshot.profiles.find(({ email }) => email)?.email || '';
  bootAppShell(document, { currentUrl: window.location.href });
  const focusCurrentSection = () => (
    focusOptionsSection(document, window.location.hash)
  );
  focusCurrentSection();
  window.addEventListener('hashchange', focusCurrentSection);
  let editingProfileId = snapshot.profiles[0]?.id ?? null;
  let editingSiteId = snapshot.promotionSites[0]?.id ?? null;
  let editingPairId = snapshot.pairs[0]?.id ?? null;
  let generatedIdentities = [];
  let promotionAnalysisSequence = 0;

  function replaceOptions(select, items, selectedId, label) {
    select.replaceChildren();
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = label(item);
      option.selected = item.id === selectedId;
      select.appendChild(option);
    }
    select.disabled = items.length === 0;
  }

  function profileById(id) {
    return snapshot.profiles.find((profile) => profile.id === id) || null;
  }

  function siteById(id) {
    return snapshot.promotionSites.find((site) => site.id === id) || null;
  }

  function pairById(id) {
    return snapshot.pairs.find((pair) => pair.id === id) || null;
  }

  function renderProfile() {
    const profile = profileById(editingProfileId);
    ui.profileDisplayName.value = profile?.displayName || '';
    ui.userName.value = profile?.name || '';
    ui.userEmail.value = profile?.email || '';
    ui.userPassword.value = '';
    const configured = Boolean(
      profile && snapshot.passwordConfigured[profile.id]
    );
    ui.passwordConfiguredStatus.textContent = configured
      ? '已配置本机密码（不会预填）'
      : '未配置密码';
    ui.clearPasswordBtn.disabled = !configured;
    ui.deleteProfileBtn.disabled = !profile;
  }

  function legacyPage(site) {
    if (!site) return null;
    return {
      id: `${site.id}-page-home`,
      url: site.url,
      keywords: [site.name],
      content: site.content,
      enabled: site.enabled,
      createdAt: site.createdAt,
      updatedAt: site.updatedAt
    };
  }

  function pageForSite(site) {
    return site?.pages?.[0] || legacyPage(site);
  }

  function parseKeywords(value) {
    return [...new Set(String(value || '')
      .split(/[\n,，]/u)
      .map((item) => item.trim())
      .filter(Boolean))];
  }

  function renderSite() {
    const site = siteById(editingSiteId);
    const page = pageForSite(site);
    ui.promotionSiteName.value = site?.name || '';
    ui.websiteEmail.value = site?.email || legacyProfileEmail;
    ui.websiteUrl.value = page?.url || '';
    ui.promotionPageKeywords.value = (page?.keywords || []).join('\n');
    ui.websiteContent.value = page?.content || '';
    ui.promotionSiteEnabled.checked = site?.enabled ?? true;
    ui.deletePromotionSiteBtn.disabled = !site;
    ui.promotionAnalysisStatus.textContent = '';
  }

  function renderPair() {
    const pair = pairById(editingPairId);
    ui.pairProfileSelect.value =
      pair?.profileId || snapshot.profiles[0]?.id || '';
    ui.pairPromotionSiteSelect.value =
      pair?.promotionSiteId || snapshot.promotionSites[0]?.id || '';
    ui.pairWeight.value = String(pair?.weight ?? 1);
    ui.pairEnabled.checked = pair?.enabled ?? true;
    ui.deletePairBtn.disabled = !pair;
  }

  function renderAll() {
    if (!profileById(editingProfileId)) {
      editingProfileId = snapshot.profiles[0]?.id ?? editingProfileId;
    }
    if (!siteById(editingSiteId)) {
      editingSiteId =
        snapshot.promotionSites[0]?.id ?? editingSiteId;
    }
    if (!pairById(editingPairId)) {
      editingPairId = snapshot.pairs[0]?.id ?? editingPairId;
    }
    replaceOptions(
      ui.profileSelect,
      snapshot.profiles,
      editingProfileId,
      ({ displayName }) => displayName
    );
    replaceOptions(
      ui.promotionSiteSelect,
      snapshot.promotionSites,
      editingSiteId,
      (site) => {
        const page = pageForSite(site);
        return `${site.name} · ${page?.url || site.url}${site.enabled ? '' : '（停用）'}`;
      }
    );
    replaceOptions(
      ui.pairProfileSelect,
      snapshot.profiles,
      pairById(editingPairId)?.profileId,
      ({ displayName }) => displayName
    );
    replaceOptions(
      ui.pairPromotionSiteSelect,
      snapshot.promotionSites,
      pairById(editingPairId)?.promotionSiteId,
      ({ name }) => name
    );
    replaceOptions(
      ui.pairSelect,
      snapshot.pairs,
      editingPairId,
      (pair) => {
        const profile = profileById(pair.profileId);
        const site = siteById(pair.promotionSiteId);
        return `${profile?.displayName || pair.profileId} → ${
          site?.name || pair.promotionSiteId
        }${pair.enabled ? '' : '（停用）'}`;
      }
    );
    replaceOptions(
      ui.defaultPairSelect,
      snapshot.pairs.filter(({ enabled }) => enabled),
      snapshot.defaultPairId,
      (pair) => {
        const profile = profileById(pair.profileId);
        const site = siteById(pair.promotionSiteId);
        return `${profile?.displayName || pair.profileId} → ${
          site?.name || pair.promotionSiteId
        }`;
      }
    );
    ui.quotaBatch.value = String(snapshot.quotas.batch);
    ui.quotaProfile.value = String(snapshot.quotas.perProfile);
    ui.quotaPromotionSite.value =
      String(snapshot.quotas.perPromotionSite);
    ui.quotaTargetDomain.value =
      String(snapshot.quotas.perTargetDomain);
    renderProfile();
    renderSite();
    renderPair();
  }
  renderAll();

  async function runConfigCommand(command, successText) {
    try {
      snapshot = await command();
      renderAll();
      showStatus(ui.settingsStatus, successText);
    } catch (error) {
      reportOptionsDiagnostic(
        'domain config command failed',
        error,
        'domain_config_command_failed'
      );
      showStatus(
        ui.settingsStatus,
        optionsErrorMessage(error, '保存失败，请稍后重试。'),
        true,
        4200
      );
    }
  }

  ui.profileSelect.addEventListener('change', () => {
    editingProfileId = ui.profileSelect.value;
    renderProfile();
  });
  ui.newProfileBtn.addEventListener('click', () => {
    editingProfileId = generatedId('profile');
    renderProfile();
    ui.profileDisplayName.focus();
  });
  ui.saveProfileBtn.addEventListener('click', () => runConfigCommand(
    async () => {
      const displayName = ui.profileDisplayName.value.trim();
      const name = ui.userName.value.trim();
      if (!displayName || !name) {
        throw codedOptionsError('missing_profile_fields');
      }
      const profileId = editingProfileId || generatedId('profile');
      editingProfileId = profileId;
      await domainController.saveProfile({
        id: profileId,
        displayName,
        name,
        email: ''
      });
      return domainController.snapshot();
    },
    'Profile 已保存'
  ));
  ui.clearPasswordBtn.addEventListener('click', () => runConfigCommand(
    async () => {
      await domainController.clearPassword(editingProfileId);
      return domainController.snapshot();
    },
    '密码已清除'
  ));
  ui.deleteProfileBtn.addEventListener('click', () => {
    if (!confirm('确认删除此身份？')) return;
    void runConfigCommand(
      () => domainController.deleteProfile(editingProfileId),
      'Profile 已删除'
    );
  });

  ui.promotionSiteSelect.addEventListener('change', () => {
    editingSiteId = ui.promotionSiteSelect.value;
    renderSite();
  });
  ui.newPromotionSiteBtn.addEventListener('click', () => {
    editingSiteId = generatedId('site');
    renderSite();
    ui.websiteEmail.value = '';
    ui.websiteUrl.focus();
  });
  ui.savePromotionSiteBtn.addEventListener('click', () => runConfigCommand(
    () => {
      const siteId = editingSiteId || generatedId('site');
      editingSiteId = siteId;
      const existing = siteById(siteId);
      const existingPage = pageForSite(existing);
      const at = Date.now();
      const page = {
        id: existingPage?.id || generatedId('page'),
        url: ui.websiteUrl.value.trim(),
        keywords: parseKeywords(ui.promotionPageKeywords.value),
        content: ui.websiteContent.value.trim(),
        enabled: ui.promotionSiteEnabled.checked,
        createdAt: existingPage?.createdAt ?? at,
        updatedAt: at
      };
      return domainController.savePromotionSite({
        id: siteId,
        name: ui.promotionSiteName.value.trim(),
        email: ui.websiteEmail.value.trim(),
        pages: [page],
        url: page.url,
        content: page.content,
        enabled: ui.promotionSiteEnabled.checked
      });
    },
    '推广页面已保存'
  ));
  ui.deletePromotionSiteBtn.addEventListener('click', () => {
    if (!confirm('确认删除此推广页面？')) {
      return;
    }
    void runConfigCommand(
      () => domainController.deletePromotionSite(editingSiteId),
      '推广页面已删除'
    );
  });

  async function requestModel({ systemPrompt, userPrompt }) {
    const response = await chrome.runtime.sendMessage({
      type: 'LLM_GENERATE_COPY',
      payload: { systemPrompt, userPrompt }
    });
    if (!response?.success || typeof response.text !== 'string') {
      throw codedOptionsError(response?.error?.code || 'model_generation_failed');
    }
    return response.text;
  }

  function fillPromotionEmailFromUrl() {
    try {
      ui.websiteEmail.value = promotionEmailForUrl(ui.websiteUrl.value);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function ensurePromotionPagePermission(pageUrl, interactive) {
    if (typeof chrome.permissions?.contains !== 'function') return true;
    const origins = [promotionPageOriginPattern(pageUrl)];
    if (await chrome.permissions.contains({ origins })) return true;
    if (!interactive || typeof chrome.permissions.request !== 'function') {
      return false;
    }
    return chrome.permissions.request({ origins });
  }

  async function fetchPromotionPageContext(pageUrl) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(pageUrl, {
        credentials: 'omit',
        redirect: 'follow',
        signal: controller.signal
      });
      if (!response.ok) throw codedOptionsError('promotion_page_fetch_failed');
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > 2_000_000) {
        throw codedOptionsError('promotion_page_too_large');
      }
      const html = (await response.text()).slice(0, 500_000);
      const page = new DOMParser().parseFromString(html, 'text/html');
      page.querySelectorAll('script, style, noscript, svg, template')
        .forEach((element) => element.remove());
      return {
        title: page.title,
        description: page.querySelector('meta[name="description"]')
          ?.getAttribute('content') || '',
        bodyText: (page.body?.innerText || page.body?.textContent || '')
          .replace(/\s+/gu, ' ')
          .trim()
          .slice(0, 16_000)
      };
    } catch (error) {
      if (error?.code) throw error;
      throw codedOptionsError('promotion_page_fetch_failed');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function analyzePromotionPage({ interactive = false } = {}) {
    const pageUrl = ui.websiteUrl.value.trim();
    if (!fillPromotionEmailFromUrl()) {
      showStatus(
        ui.promotionAnalysisStatus,
        '请先填写有效的 HTTP 或 HTTPS 推广页面 URL。',
        true,
        5000
      );
      return;
    }
    let permissionGranted;
    try {
      permissionGranted = await ensurePromotionPagePermission(
        pageUrl,
        interactive
      );
    } catch (_) {
      permissionGranted = false;
    }
    if (!permissionGranted) {
      showStatus(
        ui.promotionAnalysisStatus,
        '邮箱已自动生成。点击“AI 分析并生成”授权读取该页面。',
        false,
        10_000
      );
      return;
    }

    const sequence = ++promotionAnalysisSequence;
    ui.analyzePromotionPageBtn.disabled = true;
    showStatus(
      ui.promotionAnalysisStatus,
      '正在读取并分析推广页面…',
      false,
      60_000
    );
    try {
      const pageContext = await fetchPromotionPageContext(pageUrl);
      const analysis = parseGeneratedPromotionAnalysis(await requestModel(
        promotionPageAnalysisRequest({ pageUrl, ...pageContext })
      ));
      if (sequence !== promotionAnalysisSequence
          || pageUrl !== ui.websiteUrl.value.trim()) return;
      ui.promotionSiteName.value = analysis.name;
      ui.promotionPageKeywords.value = analysis.keywords.join('\n');
      ui.websiteContent.value = analysis.prompt;
      showStatus(
        ui.promotionAnalysisStatus,
        `分析完成：已生成 ${analysis.keywords.length} 个关键词和评论提示词。`,
        false,
        6000
      );
    } catch (error) {
      showStatus(
        ui.promotionAnalysisStatus,
        optionsErrorMessage(
          error,
          '页面分析失败，请确认网址可访问并检查模型配置后重试。'
        ),
        true,
        6000
      );
    } finally {
      if (sequence === promotionAnalysisSequence) {
        ui.analyzePromotionPageBtn.disabled = false;
      }
    }
  }

  ui.websiteUrl.addEventListener('input', () => {
    fillPromotionEmailFromUrl();
  });
  ui.websiteUrl.addEventListener('change', () => {
    void analyzePromotionPage({ interactive: true });
  });
  ui.analyzePromotionPageBtn.addEventListener('click', () => {
    void analyzePromotionPage({ interactive: true });
  });

  function renderGeneratedIdentities() {
    ui.generatedIdentityPreview.replaceChildren();
    generatedIdentities.forEach((identity, index) => {
      const row = document.createElement('div');
      row.className = 'generated-identity-row';
      const displayName = document.createElement('input');
      displayName.type = 'text';
      displayName.value = identity.displayName;
      displayName.setAttribute('aria-label', `身份 ${index + 1} 显示名`);
      displayName.addEventListener('input', () => {
        generatedIdentities[index].displayName = displayName.value;
      });
      const name = document.createElement('input');
      name.type = 'text';
      name.value = identity.name;
      name.setAttribute('aria-label', `身份 ${index + 1} 姓名`);
      name.addEventListener('input', () => {
        generatedIdentities[index].name = name.value;
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-secondary danger';
      remove.textContent = '移除';
      remove.addEventListener('click', () => {
        generatedIdentities.splice(index, 1);
        renderGeneratedIdentities();
      });
      row.append(displayName, name, remove);
      ui.generatedIdentityPreview.appendChild(row);
    });
    ui.saveGeneratedIdentitiesBtn.disabled = generatedIdentities.length === 0;
  }

  ui.generateIdentitiesBtn.addEventListener('click', async () => {
    ui.generateIdentitiesBtn.disabled = true;
    showStatus(ui.identityGeneratorStatus, '正在生成英文身份…', false, 60_000);
    try {
      const request = identityGenerationRequest(ui.identityGenerateCount.value);
      generatedIdentities = parseGeneratedIdentities(
        await requestModel(request),
        request.count
      );
      renderGeneratedIdentities();
      showStatus(
        ui.identityGeneratorStatus,
        `已生成 ${generatedIdentities.length} 个身份，可编辑后保存。`
      );
    } catch (error) {
      showStatus(
        ui.identityGeneratorStatus,
        optionsErrorMessage(error, '身份生成失败，请检查模型配置后重试。'),
        true,
        4200
      );
    } finally {
      ui.generateIdentitiesBtn.disabled = false;
    }
  });

  ui.saveGeneratedIdentitiesBtn.addEventListener('click', () => runConfigCommand(
    async () => {
      const items = generatedIdentities.map((identity) => ({
        displayName: identity.displayName.trim(),
        name: identity.name.trim()
      }));
      if (items.some(({ displayName, name }) => !displayName || !name)) {
        throw codedOptionsError('missing_profile_fields');
      }
      for (const identity of items) {
        await domainController.saveProfile({
          id: generatedId('profile'),
          ...identity,
          email: ''
        });
      }
      generatedIdentities = [];
      renderGeneratedIdentities();
      return domainController.snapshot();
    },
    'AI 身份已批量保存'
  ));

  ui.generatePromotionPromptBtn.addEventListener('click', async () => {
    ui.generatePromotionPromptBtn.disabled = true;
    showStatus(ui.settingsStatus, '正在生成推广提示词…', false, 60_000);
    try {
      const request = promotionPromptGenerationRequest({
        websiteName: ui.promotionSiteName.value,
        pageUrl: ui.websiteUrl.value,
        keywords: parseKeywords(ui.promotionPageKeywords.value)
      });
      ui.websiteContent.value = parseGeneratedPromotionPrompt(
        await requestModel(request)
      );
      showStatus(ui.settingsStatus, '推广提示词已生成，请检查后保存页面。');
    } catch (error) {
      showStatus(
        ui.settingsStatus,
        optionsErrorMessage(error, '提示词生成失败，请检查模型配置后重试。'),
        true,
        4200
      );
    } finally {
      ui.generatePromotionPromptBtn.disabled = false;
    }
  });

  ui.pairSelect.addEventListener('change', () => {
    editingPairId = ui.pairSelect.value;
    renderPair();
  });
  ui.newPairBtn.addEventListener('click', () => {
    editingPairId = generatedId('pair');
    renderPair();
  });
  ui.savePairBtn.addEventListener('click', () => runConfigCommand(
    () => {
      const pairId = editingPairId || generatedId('pair');
      editingPairId = pairId;
      return domainController.savePair({
        id: pairId,
        profileId: ui.pairProfileSelect.value,
        promotionSiteId: ui.pairPromotionSiteSelect.value,
        weight: positiveInteger(
          ui.pairWeight,
          'invalid_assignment_pair_weight'
        ),
        enabled: ui.pairEnabled.checked
      });
    },
    'Pair 已保存'
  ));
  ui.deletePairBtn.addEventListener('click', () => {
    if (!confirm('确认删除此 Pair？')) return;
    void runConfigCommand(
      () => domainController.deletePair(editingPairId),
      'Pair 已删除'
    );
  });
  ui.savePolicyBtn.addEventListener('click', () => runConfigCommand(
    () => domainController.savePolicy({
      defaultPairId: ui.defaultPairSelect.value || null,
      quotas: {
        batch: positiveInteger(ui.quotaBatch, 'invalid_quota_batch'),
        perProfile: positiveInteger(
          ui.quotaProfile,
          'invalid_quota_profile'
        ),
        perPromotionSite: positiveInteger(
          ui.quotaPromotionSite,
          'invalid_quota_promotion_site'
        ),
        perTargetDomain: positiveInteger(
          ui.quotaTargetDomain,
          'invalid_quota_target_domain'
        )
      }
    }),
    '分配策略已保存'
  ));

  const modelDependencies = {
    storage: chrome.storage,
    permissions: chrome.permissions,
    runtime: chrome.runtime
  };
  let modelConfig;
  try {
    modelConfig = await loadLlmConfig(chrome.storage);
  } catch {
    modelConfig = DEFAULT_LLM_CONFIG;
    showStatus(
      ui.llmStatus,
      '模型配置暂时无法加载，请稍后重试。',
      true,
      4200
    );
  }
  ui.llmApiBaseUrl.value =
    modelConfig.apiBaseUrl || DEFAULT_LLM_CONFIG.apiBaseUrl;
  ui.llmModel.value = modelConfig.model || DEFAULT_LLM_CONFIG.model;
  ui.llmApiKey.value = modelConfig.apiKey;
  ui.saveLlmConfigBtn.addEventListener('click', async () => {
    try {
      await saveOptionsModelConfig(modelDependencies, {
        apiBaseUrl: ui.llmApiBaseUrl.value,
        apiKey: ui.llmApiKey.value,
        model: ui.llmModel.value
      });
      showStatus(ui.llmStatus, '模型配置已保存');
    } catch (error) {
      reportOptionsDiagnostic(
        'model config save failed',
        error,
        'model_config_save_failed'
      );
      showStatus(
        ui.llmStatus,
        optionsErrorMessage(error, '模型配置保存失败，请稍后重试。'),
        true
      );
    }
  });
  ui.testLlmConnectionBtn.addEventListener('click', async () => {
    ui.testLlmConnectionBtn.disabled = true;
    try {
      const text = await testOptionsModelConfig(modelDependencies, {
        apiBaseUrl: ui.llmApiBaseUrl.value,
        apiKey: ui.llmApiKey.value,
        model: ui.llmModel.value
      });
      showStatus(ui.llmStatus, `连接成功：${text}`, false, 5000);
    } catch (error) {
      reportOptionsDiagnostic(
        'model connection test failed',
        error,
        'model_connection_test_failed'
      );
      showStatus(
        ui.llmStatus,
        optionsErrorMessage(error, '连接测试失败，请稍后重试。'),
        true,
        5000
      );
    } finally {
      ui.testLlmConnectionBtn.disabled = false;
    }
  });

  let showOutlinks = true;
  try {
    showOutlinks = (
      await chrome.storage.sync.get([
        SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY
      ])
    )[SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY] !== false;
  } catch {
    showStatus(
      ui.settingsStatus,
      '外链按钮设置暂时无法加载，当前使用默认值。',
      true,
      4200
    );
  }
  function renderOutlinksToggle() {
    ui.toggleExportOutlinksFloatingBtn.textContent = showOutlinks
      ? '隐藏导出外链按钮'
      : '显示导出外链按钮';
  }
  const outlinksToggle = bindStoredBooleanToggle({
    button: ui.toggleExportOutlinksFloatingBtn,
    initialValue: showOutlinks,
    write: (nextValue) => chrome.storage.sync.set({
      [SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY]: nextValue
    }),
    render: (nextValue) => {
      showOutlinks = nextValue;
      renderOutlinksToggle();
    },
    onCommit: () => {
      showStatus(ui.settingsStatus, '外链按钮设置已保存');
    },
    onError: () => {
      showStatus(
        ui.settingsStatus,
        '外链按钮设置保存失败，请重试。',
        true,
        4200
      );
    }
  });

  const [outlinkSyncSettings, outlinkLocalSettings] = await Promise.all([
    chrome.storage.sync.get([OUTLINK_EXPORT_FILTER_RULES_STORAGE_KEY]),
    chrome.storage.local.get([OUTLINK_EXPORT_HIDDEN_HOSTS_STORAGE_KEY])
  ]);
  const outlinkRules = globalThis.AutoCommentOutlinkRules?.normalizeRules?.(
    outlinkSyncSettings[OUTLINK_EXPORT_FILTER_RULES_STORAGE_KEY]
  ) || { excludedDomains: [], excludedKeywords: [] };
  ui.outlinkExcludedDomains.value = outlinkRules.excludedDomains.join('\n');
  ui.outlinkExcludedKeywords.value = outlinkRules.excludedKeywords.join('\n');
  ui.outlinkHiddenHosts.value = Array.isArray(
    outlinkLocalSettings[OUTLINK_EXPORT_HIDDEN_HOSTS_STORAGE_KEY]
  )
    ? outlinkLocalSettings[OUTLINK_EXPORT_HIDDEN_HOSTS_STORAGE_KEY].join('\n')
    : '';

  ui.saveOutlinkSettingsBtn.addEventListener('click', async () => {
    ui.saveOutlinkSettingsBtn.disabled = true;
    try {
      const normalizeLines = globalThis.AutoCommentOutlinkRules?.normalizeRuleLines
        || ((value) => String(value || '').split(/\r?\n/u).map((item) => item.trim()).filter(Boolean));
      const rules = globalThis.AutoCommentOutlinkRules?.normalizeRules?.({
        excludedDomains: ui.outlinkExcludedDomains.value,
        excludedKeywords: ui.outlinkExcludedKeywords.value
      }) || {
        excludedDomains: normalizeLines(ui.outlinkExcludedDomains.value),
        excludedKeywords: normalizeLines(ui.outlinkExcludedKeywords.value)
      };
      const hiddenHosts = normalizeLines(ui.outlinkHiddenHosts.value);
      await Promise.all([
        chrome.storage.sync.set({
          [OUTLINK_EXPORT_FILTER_RULES_STORAGE_KEY]: rules
        }),
        chrome.storage.local.set({
          [OUTLINK_EXPORT_HIDDEN_HOSTS_STORAGE_KEY]: hiddenHosts
        })
      ]);
      ui.outlinkExcludedDomains.value = rules.excludedDomains.join('\n');
      ui.outlinkExcludedKeywords.value = rules.excludedKeywords.join('\n');
      ui.outlinkHiddenHosts.value = hiddenHosts.join('\n');
      showStatus(ui.outlinkSettingsStatus, '外链设置已保存');
    } catch (error) {
      showStatus(ui.outlinkSettingsStatus, error.message || '保存失败', true);
    } finally {
      ui.saveOutlinkSettingsBtn.disabled = false;
    }
  });
  ui.openOutlinkTableBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('records.html') });
  });

  let localDebugSettings = (
    await chrome.storage.local.get([LOCAL_DEBUG_BRIDGE_STORAGE_KEY])
  )[LOCAL_DEBUG_BRIDGE_STORAGE_KEY] || null;
  function renderLocalDebugBridge() {
    const enabled = localDebugSettings?.enabled === true;
    ui.localDebugStatus.textContent = enabled
      ? `已启用：扩展 ID ${chrome.runtime.id}。首次使用需通过 autocommentctl 明确授权。`
      : '已关闭（默认）。';
    ui.localDebugStatus.style.color = enabled ? '#059669' : '';
    ui.toggleLocalDebugBtn.textContent = enabled
      ? '关闭本地控制'
      : '启用本地控制';
    ui.openLocalDebugBtn.disabled = !enabled;
  }
  function localDebugDashboardUrl() {
    const params = new URLSearchParams({
      extensionId: chrome.runtime.id,
      token: localDebugSettings.token
    });
    return `${LOCAL_DEBUG_BRIDGE_ORIGIN}/#${params}`;
  }
  renderLocalDebugBridge();
  ui.toggleLocalDebugBtn.addEventListener('click', async () => {
    if (localDebugSettings?.enabled === true) {
      await chrome.storage.local.remove([LOCAL_DEBUG_BRIDGE_STORAGE_KEY]);
      localDebugSettings = null;
    } else {
      localDebugSettings = {
        enabled: true,
        origin: LOCAL_DEBUG_BRIDGE_ORIGIN,
        token: `${crypto.randomUUID()}${crypto.randomUUID()}`,
        updatedAt: Date.now()
      };
      await chrome.storage.local.set({
        [LOCAL_DEBUG_BRIDGE_STORAGE_KEY]: localDebugSettings
      });
    }
    renderLocalDebugBridge();
  });
  ui.openLocalDebugBtn.addEventListener('click', () => {
    if (localDebugSettings?.enabled !== true) return;
    chrome.tabs.create({ url: localDebugDashboardUrl() });
  });

  createOptionsConfigBundleView({
    documentRef: document,
    controller: bundleController,
    downloadJson,
    onApplied: async () => {
      snapshot = await domainController.snapshot();
      renderAll();
      const importedSettings = await safeSettingsAdapter.load();
      ui.llmApiBaseUrl.value =
        importedSettings.llm.apiBaseUrl || DEFAULT_LLM_CONFIG.apiBaseUrl;
      ui.llmModel.value =
        importedSettings.llm.model || DEFAULT_LLM_CONFIG.model;
      outlinksToggle.setValue(
        importedSettings.preferences.showExportOutlinksFloatingButton
      );
    }
  });

  bindSafeTabNavigation({
    button: ui.openBatchBtn,
    open: () => chrome.tabs.create({ url: 'batch.html' }),
    onError: () => {
      showStatus(
        ui.settingsStatus,
        '批量处理页面打开失败，请稍后重试。',
        true,
        4200
      );
    }
  });
  bindSafeTabNavigation({
    button: ui.openHistoryBtn,
    open: () => chrome.tabs.create({ url: 'history.html' }),
    onError: () => {
      showStatus(
        ui.settingsStatus,
        '评论历史页面打开失败，请稍后重试。',
        true,
        4200
      );
    }
  });

  const cloudSyncElements = Object.fromEntries([
    'cloudSyncCreateBtn',
    'cloudSyncImportInput',
    'cloudSyncImportBtn',
    'cloudSyncCopyBtn',
    'cloudSyncRunBtn',
    'cloudSyncDisconnectBtn',
    'cloudSyncDeleteBtn',
    'cloudSyncStatus',
    'cloudSyncLastSuccess',
    'cloudSyncPendingCount',
    'cloudSyncDeviceId'
  ].map((id) => [id, element(id)]));
  if (Object.values(cloudSyncElements).every(Boolean)) {
    const cloudSyncController = createCloudSyncOptionsController({
      elements: cloudSyncElements,
      sendMessage: (message) => chrome.runtime.sendMessage(message),
      clipboard: navigator.clipboard,
      prompt: window.prompt.bind(window)
    });
    cloudSyncController.bind();
    await cloudSyncController.refresh();
  }

}

if (typeof document !== 'undefined') {
  installOptionsPageBoot({
    document,
    boot: () => bootOptionsPage()
  });
}
