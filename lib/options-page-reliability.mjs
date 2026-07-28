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

export function renderOptionsBootFailure(
  documentRef,
  writableControlIds = DEFAULT_WRITABLE_CONTROL_IDS
) {
  const status = documentRef?.getElementById?.('settingsStatus');
  if (status) {
    status.textContent = '设置加载失败，请重新打开页面后重试。';
    status.style.color = '#dc2626';
    status.classList.add('visible');
  }
  for (const id of writableControlIds) {
    const control = documentRef?.getElementById?.(id);
    if (control) control.disabled = true;
  }
}

export function installOptionsPageBoot({
  document: documentRef,
  boot,
  writableControlIds = DEFAULT_WRITABLE_CONTROL_IDS,
  reportError = (error) => {
    console.error(
      '[options] boot failed:',
      typeof error?.code === 'string' ? error.code : 'options_boot_failed'
    );
  }
} = {}) {
  if (!documentRef || typeof boot !== 'function') {
    throw new TypeError('document and boot are required');
  }
  documentRef.addEventListener('DOMContentLoaded', () => {
    void Promise.resolve()
      .then(() => boot())
      .catch((error) => {
        renderOptionsBootFailure(documentRef, writableControlIds);
        reportError(error);
      });
  }, { once: true });
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
  render(value);

  return Object.freeze({
    get value() {
      return value;
    },
    setValue,
    toggle
  });
}
