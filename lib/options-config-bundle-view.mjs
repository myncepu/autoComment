function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function messageFor(error) {
  return error?.code || error?.message || 'unknown_config_bundle_error';
}

function requiredElement(documentRef, id) {
  const element = documentRef?.getElementById?.(id);
  if (!element) throw codedError(`missing_config_bundle_view_element:${id}`);
  return element;
}

export function createOptionsConfigBundleView({
  documentRef,
  controller,
  downloadJson,
  onApplied
}) {
  if (typeof controller?.exportConfig !== 'function'
      || typeof controller?.previewImport !== 'function'
      || typeof controller?.applyImport !== 'function'
      || typeof downloadJson !== 'function'
      || typeof onApplied !== 'function') {
    throw codedError('invalid_options_config_bundle_view_dependencies');
  }

  const elements = {
    exportButton: requiredElement(documentRef, 'exportConfigBtn'),
    importButton: requiredElement(documentRef, 'importConfigBtn'),
    fileInput: requiredElement(documentRef, 'importConfigFileInput'),
    applyButton: requiredElement(documentRef, 'applyImportConfigBtn'),
    status: requiredElement(documentRef, 'importExportStatus'),
    summary: requiredElement(documentRef, 'importPreviewSummary')
  };
  let busy = false;
  let destroyed = false;
  let pendingPreview = null;

  function setBusy(value) {
    busy = value;
    elements.exportButton.disabled = value;
    elements.importButton.disabled = value;
    elements.fileInput.disabled = value;
    elements.applyButton.disabled = value;
    elements.status.setAttribute('aria-busy', String(value));
  }

  function renderStatus(text, isError = false) {
    elements.status.textContent = text;
    elements.status.classList.toggle('status-warning', isError);
    elements.status.classList.toggle('visible', Boolean(text));
  }

  function clearPreview() {
    pendingPreview = null;
    elements.applyButton.hidden = true;
    elements.summary.hidden = true;
    elements.summary.textContent = '';
  }

  function renderPreview(preview) {
    const created = Array.isArray(preview?.creates)
      ? preview.creates.length
      : 0;
    const updated = Array.isArray(preview?.updates)
      ? preview.updates.length
      : 0;
    const settingChanges = Array.isArray(preview?.settingChanges)
      ? preview.settingChanges.map((name) => String(name))
      : [];
    const conflictCodes = Array.isArray(preview?.conflicts)
      ? preview.conflicts.map(({ code }) => String(code))
      : [];
    const summary = [
      `新增 ${created}`,
      `更新 ${updated}`,
      `设置变化 ${settingChanges.length}`
    ];
    if (settingChanges.length > 0) {
      summary.push(`设置项 ${settingChanges.join('、')}`);
    }
    if (conflictCodes.length > 0) {
      summary.push(`冲突 ${conflictCodes.join('、')}`);
    }
    elements.summary.textContent = summary.join('；');
    elements.summary.hidden = false;
    elements.applyButton.hidden = conflictCodes.length > 0;
    renderStatus(
      conflictCodes.length > 0
        ? `导入被阻止：${conflictCodes.join('、')}`
        : '预览已生成，请确认后应用',
      conflictCodes.length > 0
    );
  }

  async function run(command) {
    if (busy || destroyed) return;
    setBusy(true);
    try {
      await command();
    } finally {
      if (!destroyed) setBusy(false);
    }
  }

  function handleExport() {
    void run(async () => {
      try {
        const exported = await controller.exportConfig();
        if (destroyed) return;
        downloadJson(
          exported,
          `autocomment-config-${new Date().toISOString().slice(0, 10)}.json`
        );
        renderStatus('非敏感配置已导出');
      } catch (error) {
        if (!destroyed) {
          renderStatus(`导出失败：${messageFor(error)}`, true);
        }
      }
    });
  }

  function handleImport() {
    if (busy || destroyed) return;
    elements.fileInput.click();
  }

  function handleFileSelection() {
    const file = elements.fileInput.files?.[0] || null;
    elements.fileInput.value = '';
    if (busy || destroyed) return;
    if (!file) return;

    clearPreview();
    void run(async () => {
      try {
        const source = await file.text();
        if (destroyed) return;
        let input;
        try {
          input = JSON.parse(source);
        } catch {
          throw codedError('JSON 格式无效');
        }
        const preview = await controller.previewImport(input);
        if (destroyed) return;
        pendingPreview = preview;
        renderPreview(preview);
      } catch (error) {
        if (!destroyed) {
          clearPreview();
          renderStatus(`导入失败：${messageFor(error)}`, true);
        }
      }
    });
  }

  function handleApply() {
    if (busy || destroyed || !pendingPreview) return;
    const preview = pendingPreview;
    void run(async () => {
      let result;
      try {
        result = await controller.applyImport(preview);
      } catch (error) {
        if (!destroyed) {
          clearPreview();
          renderStatus(`应用失败：${messageFor(error)}`, true);
        }
        return;
      }
      if (destroyed) return;
      clearPreview();
      try {
        await onApplied(result);
      } catch {
        if (!destroyed) {
          renderStatus(
            '配置已应用，但页面刷新失败；请重新加载',
            true
          );
        }
        return;
      }
      if (!destroyed) renderStatus('导入已应用');
    });
  }

  elements.exportButton.addEventListener('click', handleExport);
  elements.importButton.addEventListener('click', handleImport);
  elements.fileInput.addEventListener('change', handleFileSelection);
  elements.applyButton.addEventListener('click', handleApply);
  clearPreview();
  setBusy(false);

  return Object.freeze({
    destroy() {
      if (destroyed) return;
      destroyed = true;
      pendingPreview = null;
      elements.exportButton.removeEventListener('click', handleExport);
      elements.importButton.removeEventListener('click', handleImport);
      elements.fileInput.removeEventListener('change', handleFileSelection);
      elements.applyButton.removeEventListener('click', handleApply);
    }
  });
}
