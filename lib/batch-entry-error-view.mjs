import { runtimeErrorMessage } from './batch-console-state.mjs';

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : fallback;
}

export function renderBatchBootFailure(
  documentRef,
  { code = 'batch_boot_failed', onRetry } = {}
) {
  const mount = documentRef?.querySelector?.('[data-batch-console]');
  if (!mount) return null;

  const safeCode = text(code, 'batch_boot_failed')
    .replace(/[^a-z0-9_:-]/gi, '')
    .slice(0, 80);
  mount.textContent = '';
  const alert = documentRef.createElement('section');
  alert.className =
    'batch-console__banner batch-console__banner--error';
  alert.dataset.batchBootFailure = '';
  alert.dataset.diagnosticCode = safeCode;
  alert.setAttribute('role', 'alert');
  alert.setAttribute('aria-live', 'assertive');

  const heading = documentRef.createElement('h1');
  heading.textContent = '批次控制台暂时无法启动';
  const message = documentRef.createElement('p');
  message.textContent = runtimeErrorMessage(safeCode);
  const guidance = documentRef.createElement('p');
  guidance.textContent =
    '请重新加载批次页；如果问题持续出现，请先到设置页检查配置。';
  const actions = documentRef.createElement('div');
  actions.className = 'batch-console__command-actions';

  const retry = documentRef.createElement('button');
  retry.type = 'button';
  retry.className =
    'batch-console__button batch-console__button--primary';
  retry.dataset.action = 'retry-batch-boot';
  retry.textContent = '重新加载批次页';
  retry.addEventListener('click', () => onRetry?.());

  const settings = documentRef.createElement('a');
  settings.className = 'batch-console__button';
  settings.href = 'options.html';
  settings.textContent = '打开设置';
  actions.append(retry, settings);
  alert.append(heading, message, guidance, actions);
  mount.appendChild(alert);

  const wizard = documentRef.querySelector('[data-batch-wizard]');
  if (wizard?.open) wizard.close();
  return alert;
}
