import { buildConfigBundle } from './config-bundle.mjs';

export const PORTABLE_SYNC_KEYS = Object.freeze([
  'llm_api_base_url',
  'llm_model',
  'batch_checkbox_settings',
  'batch_concurrency',
  'batch_timeout_seconds',
  'show_export_outlinks_floating_button'
]);

const EMPTY_DOMAIN_CONFIG = Object.freeze({
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
});

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalize(settings) {
  return buildConfigBundle({
    domainConfig: EMPTY_DOMAIN_CONFIG,
    llm: settings.llm,
    batchDefaults: settings.batchDefaults,
    preferences: settings.preferences
  }, { exportedAt: 0 }).data;
}

function settingsFromStorage(values) {
  const automation = values.batch_checkbox_settings || {};
  return normalize({
    llm: {
      apiBaseUrl: values.llm_api_base_url || 'https://openrouter.ai/api/v1',
      model: values.llm_model || 'qwen/qwen-plus'
    },
    batchDefaults: {
      autoOpenPanel: automation.autoOpenPanel === true,
      autoGenerate: automation.autoGenerate !== false,
      autoSubmit: automation.autoSubmit === true,
      concurrency: values.batch_concurrency ?? 3,
      timeoutSeconds: values.batch_timeout_seconds ?? 60
    },
    preferences: {
      showExportOutlinksFloatingButton:
        values.show_export_outlinks_floating_button === true
    }
  });
}

export function createSafeOptionsSettingsAdapter(syncStorage) {
  if (typeof syncStorage?.get !== 'function' || typeof syncStorage?.set !== 'function') {
    throw codedError('invalid_safe_options_settings_storage');
  }

  return Object.freeze({
    async load() {
      const values = await syncStorage.get(PORTABLE_SYNC_KEYS);
      const { llm, batchDefaults, preferences } = settingsFromStorage(values);
      return { llm, batchDefaults, preferences };
    },

    async save(settings) {
      const { llm, batchDefaults, preferences } = normalize(settings);
      await syncStorage.set({
        llm_api_base_url: llm.apiBaseUrl,
        llm_model: llm.model,
        batch_checkbox_settings: {
          autoOpenPanel: batchDefaults.autoOpenPanel,
          autoGenerate: batchDefaults.autoGenerate,
          autoSubmit: batchDefaults.autoSubmit
        },
        batch_concurrency: batchDefaults.concurrency,
        batch_timeout_seconds: batchDefaults.timeoutSeconds,
        show_export_outlinks_floating_button:
          preferences.showExportOutlinksFloatingButton
      });
    }
  });
}
