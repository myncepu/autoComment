import {
  isConfigBundle,
  parseConfigBundle
} from '../../lib/config-bundle.mjs';
import {
  createOptionsConfigBundleController
} from '../../lib/options-config-bundle-controller.mjs';
import {
  createOptionsConfigBundleView
} from '../../lib/options-config-bundle-view.mjs';

const initialDomainConfig = {
  version: 2,
  revision: 0,
  profiles: [],
  promotionSites: [],
  assignmentPolicy: {
    defaultPairId: null,
    pairs: [],
    quotas: {
      batch: 100,
      perProfile: 50,
      perPromotionSite: 50,
      perTargetDomain: 3
    }
  }
};

const initialSettings = {
  llm: {
    apiBaseUrl: 'http://127.0.0.1:4173/v1',
    model: 'fixture-before-import'
  },
  batchDefaults: {
    autoOpenPanel: false,
    autoGenerate: false,
    autoSubmit: false,
    concurrency: 1,
    timeoutSeconds: 60
  },
  preferences: {
    showExportOutlinksFloatingButton: false
  }
};

let currentDomainConfig = structuredClone(initialDomainConfig);
let currentSettings = structuredClone(initialSettings);
let domainWrites = 0;
let settingsWrites = 0;

const elements = {
  autoGenerate: document.getElementById('fixtureAutoGenerate'),
  autoSubmit: document.getElementById('fixtureAutoSubmit'),
  concurrency: document.getElementById('fixtureConcurrency'),
  domainContent: document.getElementById('fixtureDomainContent'),
  domainWrites: document.getElementById('fixtureDomainWrites'),
  exportStatus: document.getElementById('fixtureExportStatus'),
  failSettingsSave: document.getElementById('fixtureFailSettingsSave'),
  pairCount: document.getElementById('fixturePairCount'),
  pairWeight: document.getElementById('fixturePairWeight'),
  perTargetDomain: document.getElementById('fixturePerTargetDomain'),
  previewDetails: document.getElementById('fixturePreviewDetails'),
  profileCount: document.getElementById('fixtureProfileCount'),
  profileDisplayName: document.getElementById('fixtureProfileDisplayName'),
  promotionSiteCount: document.getElementById('fixturePromotionSiteCount'),
  promotionSiteContent: document.getElementById('fixturePromotionSiteContent'),
  rollbackStatus: document.getElementById('fixtureRollbackStatus'),
  settingsWrites: document.getElementById('fixtureSettingsWrites'),
  timeoutSeconds: document.getElementById('fixtureTimeoutSeconds')
};

function clone(value) {
  return structuredClone(value);
}

function comparableDomain(config) {
  const value = clone(config);
  delete value.revision;
  return JSON.stringify(value);
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function renderState() {
  elements.profileCount.textContent = String(currentDomainConfig.profiles.length);
  elements.promotionSiteCount.textContent = String(
    currentDomainConfig.promotionSites.length
  );
  elements.pairCount.textContent = String(
    currentDomainConfig.assignmentPolicy.pairs.length
  );
  elements.profileDisplayName.textContent = (
    currentDomainConfig.profiles[0]?.displayName || '—'
  );
  elements.promotionSiteContent.textContent = (
    currentDomainConfig.promotionSites[0]?.content || '—'
  );
  elements.pairWeight.textContent = String(
    currentDomainConfig.assignmentPolicy.pairs[0]?.weight || '—'
  );
  elements.perTargetDomain.textContent = String(
    currentDomainConfig.assignmentPolicy.quotas.perTargetDomain
  );
  elements.domainContent.textContent = comparableDomain(currentDomainConfig);
  elements.autoGenerate.checked = currentSettings.batchDefaults.autoGenerate;
  elements.autoSubmit.checked = currentSettings.batchDefaults.autoSubmit;
  elements.concurrency.value = String(currentSettings.batchDefaults.concurrency);
  elements.timeoutSeconds.value = String(
    currentSettings.batchDefaults.timeoutSeconds
  );
  elements.domainWrites.textContent = String(domainWrites);
  elements.settingsWrites.textContent = String(settingsWrites);
}

const configRepository = {
  async load() {
    return clone(currentDomainConfig);
  },
  async replaceIfRevision(expectedRevision, next) {
    if (currentDomainConfig.revision !== expectedRevision) {
      throw codedError('stale_domain_config_revision');
    }
    domainWrites += 1;
    currentDomainConfig = {
      ...clone(next),
      revision: currentDomainConfig.revision + 1
    };
    renderState();
    return clone(currentDomainConfig);
  }
};

const settingsAdapter = {
  async load() {
    return clone(currentSettings);
  },
  async save(next) {
    settingsWrites += 1;
    if (elements.failSettingsSave.checked) {
      elements.failSettingsSave.checked = false;
      renderState();
      throw codedError('fixture_settings_save_failed');
    }
    currentSettings = clone(next);
    renderState();
  }
};

const domainController = {
  async previewImport() {
    throw codedError('fixture_legacy_import_not_supported');
  },
  async applyImport() {
    throw codedError('fixture_legacy_import_not_supported');
  }
};

const controller = createOptionsConfigBundleController({
  configRepository,
  domainController,
  settingsAdapter,
  now: () => 1785110400000
});

const observedController = {
  exportConfig() {
    return controller.exportConfig();
  },
  async previewImport(input) {
    elements.rollbackStatus.textContent = '';
    if (isConfigBundle(input)) {
      const imported = parseConfigBundle(input);
      const preview = await controller.previewImport(input);
      elements.previewDetails.textContent = [
        `${imported.domainConfig.profiles.length} Profiles`,
        `${imported.domainConfig.promotionSites.length} Sites`,
        `${imported.domainConfig.assignmentPolicy.pairs.length} Pairs`,
        `${preview.settingChanges.length} setting groups`
      ].join(' · ');
      return preview;
    }
    return controller.previewImport(input);
  },
  async applyImport(preview) {
    const beforeDomainContent = comparableDomain(currentDomainConfig);
    try {
      return await controller.applyImport(preview);
    } catch (error) {
      const restored = comparableDomain(currentDomainConfig) === beforeDomainContent;
      elements.rollbackStatus.textContent = restored
        ? '回滚完成：域内容已恢复'
        : '回滚失败：域内容未恢复';
      throw error;
    } finally {
      renderState();
    }
  }
};

function downloadJson(value, fileName) {
  elements.exportStatus.textContent = [
    fileName,
    value.format,
    `Profiles ${value.data.domainConfig.profiles.length}`
  ].join(' · ');
}

createOptionsConfigBundleView({
  documentRef: document,
  controller: observedController,
  downloadJson,
  onApplied: async () => {
    renderState();
  }
});

renderState();
