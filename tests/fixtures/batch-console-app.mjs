import { bootAppShell } from '../../lib/app-shell.mjs';
import { createBatchWizardView } from '../../lib/batch-wizard-view.mjs';
import { createBatchConsoleFixtureAdapter } from './batch-console-adapter.mjs';

function parseErrorMessage(error) {
  if (error?.message === 'csv_empty') return 'CSV 为空或没有数据行';
  if (error?.message === 'csv_parse_failed') return 'CSV 无法解析，请检查引号与列格式';
  return '无法读取 CSV 文件';
}

export function bootBatchConsoleFixture(
  documentRef,
  adapter = createBatchConsoleFixtureAdapter()
) {
  const trigger = documentRef?.querySelector?.('[data-action="new-batch"]');
  const wizardMount = documentRef?.querySelector?.('[data-batch-wizard]');
  const commandStatus = documentRef?.querySelector?.('[data-fixture-command-status]');
  if (!trigger || !wizardMount || !commandStatus) return null;

  bootAppShell(documentRef, {
    currentUrl: documentRef.location?.href,
    onNavigate(href, item) {
      const notice = documentRef.querySelector('[data-fixture-navigation-status]');
      if (notice) notice.textContent = `fixture 保持在当前页：${item.label}（${href}）`;
    }
  });

  let draft = adapter.application.loadDraft();
  let destroyed = false;
  let view;

  function save(nextDraft) {
    draft = adapter.application.saveDraft(nextDraft);
  }

  view = createBatchWizardView(documentRef, {
    onDraftChange(nextDraft) {
      save(nextDraft);
    },
    async onParseFile(file, currentDraft) {
      save({ ...currentDraft, preflight: null, parseError: '' });
      view.render(draft);
      try {
        const parsed = await adapter.application.parseFile(file);
        if (destroyed) return;
        save({ ...draft, ...parsed });
        view.render(draft);
      } catch (error) {
        if (destroyed) return;
        save({
          ...draft,
          preflight: null,
          parseError: parseErrorMessage(error)
        });
        view.render(draft);
      }
    },
    getReadinessError(currentDraft) {
      return adapter.application.getReadinessError(currentDraft);
    },
    async onStart(currentDraft) {
      commandStatus.textContent = '正在执行 fixture 批次…';
      try {
        const result = await adapter.controller.start(currentDraft);
        if (destroyed) return;
        commandStatus.textContent = `${result.batchId} · ${result.status} · `
          + `成功 ${result.counts.success}/${result.counts.total}`;
        view.close();
      } catch (_) {
        if (destroyed) return;
        commandStatus.textContent = 'fixture 批次启动失败';
      }
    },
    onCancel(currentDraft) {
      save(currentDraft);
    }
  });

  function openWizard() {
    draft = adapter.application.loadDraft();
    view.open(draft);
  }

  trigger.addEventListener('click', openWizard);

  return {
    view,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      trigger.removeEventListener('click', openWizard);
      view.destroy();
    }
  };
}

if (typeof document !== 'undefined') {
  bootBatchConsoleFixture(document);
}
