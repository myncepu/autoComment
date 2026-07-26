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
  createDomainConfigRepository
} from './lib/domain-config-repository.mjs';
import {
  createProfileSecretRepository
} from './lib/profile-secret-repository.mjs';
import {
  migrateLegacyDomainConfig
} from './lib/domain-config-migration.mjs';
import {
  createDomainConfigOptionsController
} from './lib/domain-config-options-controller.mjs';

const SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY =
  'show_export_outlinks_floating_button';

function element(id) {
  return document.getElementById(id);
}

function generatedId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function positiveInteger(input, label) {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label}必须是正整数`);
  }
  return value;
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

document.addEventListener('DOMContentLoaded', async () => {
  bootAppShell(document, { currentUrl: window.location.href });
  const focusCurrentSection = () => (
    focusOptionsSection(document, window.location.hash)
  );
  focusCurrentSection();
  window.addEventListener('hashchange', focusCurrentSection);

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
    'promotionSiteSelect',
    'newPromotionSiteBtn',
    'promotionSiteName',
    'websiteUrl',
    'websiteContent',
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
    'openBatchBtn',
    'openHistoryBtn',
    'toggleExportOutlinksFloatingBtn'
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

  const configRepository = createDomainConfigRepository(chrome.storage.local);
  const secretRepository =
    createProfileSecretRepository(chrome.storage.local);
  const controller = createDomainConfigOptionsController({
    configRepository,
    secretRepository
  });
  try {
    await migrateLegacyDomainConfig({
      storage: chrome.storage,
      configRepository,
      secretRepository
    });
  } catch (_) {
    showStatus(
      ui.settingsStatus,
      '旧配置迁移尚未完成，请检查现有配置',
      true,
      5000
    );
  }

  let snapshot = await controller.snapshot();
  let editingProfileId = snapshot.profiles[0]?.id ?? null;
  let editingSiteId = snapshot.promotionSites[0]?.id ?? null;
  let editingPairId = snapshot.pairs[0]?.id ?? null;
  let pendingImportPreview = null;

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

  function renderSite() {
    const site = siteById(editingSiteId);
    ui.promotionSiteName.value = site?.name || '';
    ui.websiteUrl.value = site?.url || '';
    ui.websiteContent.value = site?.content || '';
    ui.promotionSiteEnabled.checked = site?.enabled ?? true;
    ui.deletePromotionSiteBtn.disabled = !site;
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
      ({ name, enabled }) => `${name}${enabled ? '' : '（停用）'}`
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

  async function runConfigCommand(command, successText) {
    try {
      snapshot = await command();
      renderAll();
      showStatus(ui.settingsStatus, successText);
    } catch (error) {
      showStatus(
        ui.settingsStatus,
        error?.message || '保存失败',
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
      const email = ui.userEmail.value.trim();
      if (!displayName || !name || !email) {
        throw new Error('请填写显示名、姓名和邮箱');
      }
      const profileId = editingProfileId || generatedId('profile');
      editingProfileId = profileId;
      await controller.saveProfile({
        id: profileId,
        displayName,
        name,
        email
      });
      if (ui.userPassword.value !== '') {
        await controller.savePassword(
          editingProfileId,
          ui.userPassword.value
        );
      }
      return controller.snapshot();
    },
    'Profile 已保存'
  ));
  ui.clearPasswordBtn.addEventListener('click', () => runConfigCommand(
    async () => {
      await controller.clearPassword(editingProfileId);
      return controller.snapshot();
    },
    '密码已清除'
  ));
  ui.deleteProfileBtn.addEventListener('click', () => {
    if (!confirm('确认删除此 Profile？已被 Pair 使用时不会删除。')) return;
    void runConfigCommand(
      () => controller.deleteProfile(editingProfileId),
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
    ui.promotionSiteName.focus();
  });
  ui.savePromotionSiteBtn.addEventListener('click', () => runConfigCommand(
    () => {
      const siteId = editingSiteId || generatedId('site');
      editingSiteId = siteId;
      return controller.savePromotionSite({
        id: siteId,
        name: ui.promotionSiteName.value.trim(),
        url: ui.websiteUrl.value.trim(),
        content: ui.websiteContent.value.trim(),
        enabled: ui.promotionSiteEnabled.checked
      });
    },
    'Promotion Site 已保存'
  ));
  ui.deletePromotionSiteBtn.addEventListener('click', () => {
    if (!confirm('确认删除此 Promotion Site？已被 Pair 使用时不会删除。')) {
      return;
    }
    void runConfigCommand(
      () => controller.deletePromotionSite(editingSiteId),
      'Promotion Site 已删除'
    );
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
      return controller.savePair({
        id: pairId,
        profileId: ui.pairProfileSelect.value,
        promotionSiteId: ui.pairPromotionSiteSelect.value,
        weight: positiveInteger(ui.pairWeight, '权重'),
        enabled: ui.pairEnabled.checked
      });
    },
    'Pair 已保存'
  ));
  ui.deletePairBtn.addEventListener('click', () => {
    if (!confirm('确认删除此 Pair？')) return;
    void runConfigCommand(
      () => controller.deletePair(editingPairId),
      'Pair 已删除'
    );
  });
  ui.savePolicyBtn.addEventListener('click', () => runConfigCommand(
    () => controller.savePolicy({
      defaultPairId: ui.defaultPairSelect.value || null,
      quotas: {
        batch: positiveInteger(ui.quotaBatch, '批次上限'),
        perProfile: positiveInteger(ui.quotaProfile, '每 Profile 上限'),
        perPromotionSite: positiveInteger(
          ui.quotaPromotionSite,
          '每 Promotion Site 上限'
        ),
        perTargetDomain: positiveInteger(
          ui.quotaTargetDomain,
          '每目标域名上限'
        )
      }
    }),
    '分配策略已保存'
  ));

  ui.exportConfigBtn.addEventListener('click', async () => {
    try {
      const exported = await controller.exportConfig();
      downloadJson(
        exported,
        `autocomment-domain-config-${
          new Date().toISOString().slice(0, 10)
        }.json`
      );
      showStatus(ui.importExportStatus, '非敏感配置已导出');
    } catch (error) {
      showStatus(ui.importExportStatus, error.message, true);
    }
  });
  ui.importConfigBtn.addEventListener(
    'click',
    () => ui.importConfigFileInput.click()
  );
  ui.importConfigFileInput.addEventListener('change', async () => {
    const file = ui.importConfigFileInput.files?.[0];
    ui.importConfigFileInput.value = '';
    if (!file) return;
    try {
      const input = JSON.parse(await file.text());
      pendingImportPreview = await controller.previewImport(input);
      const conflictText = pendingImportPreview.conflicts
        .map(({ code }) => code)
        .join('、');
      if (conflictText) {
        ui.applyImportConfigBtn.hidden = true;
        showStatus(
          ui.importExportStatus,
          `导入被阻止：${conflictText}`,
          true,
          6000
        );
        return;
      }
      ui.applyImportConfigBtn.hidden = false;
      showStatus(
        ui.importExportStatus,
        `预览：新增 ${pendingImportPreview.creates.length}，更新 ${
          pendingImportPreview.updates.length
        }。请确认应用。`,
        false,
        8000
      );
    } catch (error) {
      pendingImportPreview = null;
      ui.applyImportConfigBtn.hidden = true;
      showStatus(ui.importExportStatus, `导入失败：${error.message}`, true);
    }
  });
  ui.applyImportConfigBtn.addEventListener('click', () => {
    if (!pendingImportPreview) return;
    const preview = pendingImportPreview;
    pendingImportPreview = null;
    ui.applyImportConfigBtn.hidden = true;
    void runConfigCommand(
      () => controller.applyImport(preview),
      '导入已应用'
    );
  });

  const modelDependencies = {
    storage: chrome.storage,
    permissions: chrome.permissions,
    runtime: chrome.runtime
  };
  const modelConfig = await loadLlmConfig(chrome.storage);
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
      showStatus(ui.llmStatus, error.message, true);
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
      showStatus(ui.llmStatus, error.message, true, 5000);
    } finally {
      ui.testLlmConnectionBtn.disabled = false;
    }
  });

  let showOutlinks = (
    await chrome.storage.sync.get([
      SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY
    ])
  )[SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY] !== false;
  function renderOutlinksToggle() {
    ui.toggleExportOutlinksFloatingBtn.textContent = showOutlinks
      ? '隐藏导出外链按钮'
      : '显示导出外链按钮';
  }
  renderOutlinksToggle();
  ui.toggleExportOutlinksFloatingBtn.addEventListener('click', async () => {
    showOutlinks = !showOutlinks;
    await chrome.storage.sync.set({
      [SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY]: showOutlinks
    });
    renderOutlinksToggle();
  });

  ui.openBatchBtn.addEventListener(
    'click',
    () => chrome.tabs.create({ url: 'batch.html' })
  );
  ui.openHistoryBtn.addEventListener(
    'click',
    () => chrome.tabs.create({ url: 'history.html' })
  );

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

  renderAll();
});
