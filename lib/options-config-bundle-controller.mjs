import {
  buildConfigBundle,
  isConfigBundle,
  parseConfigBundle
} from './config-bundle.mjs';
import {
  buildDomainConfigExport,
  previewDomainConfigImport
} from './domain-config-import-export.mjs';

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value, visited = new WeakSet()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value);
  Object.values(value).forEach((child) => deepFreeze(child, visited));
  return Object.freeze(value);
}

function immutableClone(value) {
  return deepFreeze(structuredClone(value));
}

function domainPreviewSummary(preview) {
  return {
    creates: Array.isArray(preview?.creates) ? structuredClone(preview.creates) : [],
    updates: Array.isArray(preview?.updates) ? structuredClone(preview.updates) : [],
    conflicts: Array.isArray(preview?.conflicts)
      ? structuredClone(preview.conflicts)
      : []
  };
}

function changedSettings(current, imported) {
  return ['llm', 'batchDefaults', 'preferences'].filter((key) => (
    JSON.stringify(current[key]) !== JSON.stringify(imported[key])
  ));
}

export function createOptionsConfigBundleController({
  configRepository,
  domainController,
  settingsAdapter,
  now = Date.now
}) {
  if (typeof configRepository?.load !== 'function'
      || typeof configRepository?.replace !== 'function'
      || typeof domainController?.previewImport !== 'function'
      || typeof domainController?.applyImport !== 'function'
      || typeof settingsAdapter?.load !== 'function'
      || typeof settingsAdapter?.save !== 'function'
      || typeof now !== 'function') {
    throw codedError('invalid_options_config_bundle_dependencies');
  }

  let previewSequence = 0;
  const previews = new Map();

  function storePreview(raw) {
    previewSequence += 1;
    const previewId = `config-bundle-preview-${previewSequence}`;
    previews.set(previewId, structuredClone(raw));
    return previewId;
  }

  async function exportConfig() {
    const [domainConfig, loadedSettings] = await Promise.all([
      configRepository.load(),
      settingsAdapter.load()
    ]);
    return immutableClone(buildConfigBundle({
      domainConfig,
      llm: loadedSettings.llm,
      batchDefaults: loadedSettings.batchDefaults,
      preferences: loadedSettings.preferences
    }, { exportedAt: now() }));
  }

  async function previewImport(input) {
    if (!isConfigBundle(input)) {
      const domainPreview = await domainController.previewImport(input);
      const previewId = storePreview({ kind: 'domain', domainPreview });
      return immutableClone({ previewId, ...domainPreviewSummary(domainPreview) });
    }

    const imported = parseConfigBundle(input);
    const [beforeDomainConfig, beforeSettings] = await Promise.all([
      configRepository.load(),
      settingsAdapter.load()
    ]);
    const domainPreview = previewDomainConfigImport(beforeDomainConfig,
      buildDomainConfigExport(imported.domainConfig, { exportedAt: now() }));
    const previewId = storePreview({
      kind: 'bundle',
      domainPreview,
      importedSettings: {
        llm: imported.llm,
        batchDefaults: imported.batchDefaults,
        preferences: imported.preferences
      },
      beforeDomainConfig,
      beforeSettings
    });
    return immutableClone({
      previewId,
      ...domainPreviewSummary(domainPreview),
      settingChanges: changedSettings(beforeSettings, imported)
    });
  }

  async function applyImport(preview) {
    const previewId = preview?.previewId;
    const raw = previews.get(previewId);
    if (!raw) throw codedError('stale_config_bundle_preview');
    previews.delete(previewId);

    if (raw.kind === 'domain') {
      return domainController.applyImport(structuredClone(raw.domainPreview));
    }

    await configRepository.replace(raw.domainPreview.mergedConfig);
    try {
      await settingsAdapter.save(raw.importedSettings);
    } catch (_) {
      try {
        await configRepository.replace(raw.beforeDomainConfig);
      } catch {
        throw codedError('config_bundle_rollback_failed');
      }
      throw codedError('config_bundle_apply_failed');
    }
  }

  return Object.freeze({ exportConfig, previewImport, applyImport });
}
