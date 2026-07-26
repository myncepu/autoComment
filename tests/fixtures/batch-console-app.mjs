import { bootAppShell } from '../../lib/app-shell.mjs';
import { createBatchConsoleView } from '../../lib/batch-console-view.mjs';
import { createBatchWizardView } from '../../lib/batch-wizard-view.mjs';
import { createBatchConsoleFixtureAdapter } from './batch-console-adapter.mjs';

function parseErrorMessage(error) {
  if (error?.message === 'csv_empty') return 'CSV 为空或没有数据行';
  if (error?.message === 'csv_parse_failed') {
    return 'CSV 无法解析，请检查引号与列格式';
  }
  return '无法读取 CSV 文件';
}

export function bootBatchConsoleFixture(
  documentRef,
  adapter = createBatchConsoleFixtureAdapter()
) {
  const consoleMount = documentRef?.querySelector?.('[data-batch-console]');
  const wizardMount = documentRef?.querySelector?.('[data-batch-wizard]');
  const commandStatus = documentRef?.querySelector?.('[data-fixture-command-status]');
  const scenario = documentRef?.querySelector?.('[data-fixture-scenario]');
  if (!consoleMount || !wizardMount || !commandStatus || !scenario) return null;

  bootAppShell(documentRef, {
    currentUrl: documentRef.location?.href,
    onNavigate(href, item) {
      const notice = documentRef.querySelector('[data-fixture-navigation-status]');
      if (notice) {
        notice.textContent = `fixture 保持在当前页：${item.label}（${href}）`;
      }
    }
  });

  let draft = adapter.application.loadDraft();
  let destroyed = false;
  let wizardView;

  function save(nextDraft) {
    draft = adapter.application.saveDraft(nextDraft);
  }

  async function run(operation) {
    try {
      return await operation();
    } catch (_) {
      return null;
    }
  }

  const consoleView = createBatchConsoleView(documentRef, {
    onPause() {
      void run(() => adapter.controller.pause());
    },
    onResume() {
      void run(() => adapter.controller.resume());
    },
    onStop(confirmedRisk) {
      void run(() => adapter.controller.stop(confirmedRisk));
    },
    onRetry(row, confirmedRisk) {
      void run(() => adapter.controller.retry({
        urlIndex: row.urlIndex,
        attempt: row.attempt
      }, confirmedRisk));
    },
    onOpenManual(row) {
      void run(() => adapter.controller.openManual({
        urlIndex: row.urlIndex,
        attempt: row.attempt
      }));
    },
    onManualUpdate(row, status) {
      void run(() => adapter.controller.manualUpdate({
        urlIndex: row.urlIndex,
        attempt: row.attempt
      }, status));
    },
    onFocusTab(row) {
      void run(() => adapter.controller.focusTab({
        urlIndex: row.urlIndex,
        attempt: row.attempt
      }));
    },
    onFilterChange(filters) {
      adapter.application.setFilters(filters);
    },
    onNewBatch() {
      draft = adapter.application.loadDraft();
      wizardView.open(draft);
    },
    onExport() {
      void run(() => adapter.controller.export());
    }
  });

  wizardView = createBatchWizardView(documentRef, {
    onDraftChange(nextDraft) {
      save(nextDraft);
    },
    async onParseFile(file, currentDraft) {
      save({ ...currentDraft, preflight: null, parseError: '' });
      wizardView.render(draft);
      try {
        const parsed = await adapter.application.parseFile(file);
        if (destroyed) return;
        save({ ...draft, ...parsed });
        wizardView.render(draft);
      } catch (error) {
        if (destroyed) return;
        save({
          ...draft,
          preflight: null,
          parseError: parseErrorMessage(error)
        });
        wizardView.render(draft);
      }
    },
    getReadinessError(currentDraft) {
      return adapter.application.getReadinessError(currentDraft);
    },
    async onStart(currentDraft) {
      commandStatus.textContent = '正在执行 fixture 批次…';
      try {
        const result = await adapter.controller.start(currentDraft);
        if (destroyed || !result) return;
        commandStatus.textContent = `${result.batchId} · ${result.status} · `
          + `成功 ${result.counts.success}/${result.counts.total}`;
        wizardView.close();
      } catch (_) {
        if (destroyed) return;
        commandStatus.textContent = 'fixture 批次启动失败';
      }
    },
    onCancel(currentDraft) {
      save(currentDraft);
    }
  });

  const unsubscribe = adapter.application.subscribe((nextSnapshot) => {
    if (!destroyed) consoleView.render(nextSnapshot);
  });
  consoleView.render(adapter.application.getSnapshot());

  function onScenarioChange() {
    adapter.application.selectScenario(scenario.value);
  }

  scenario.addEventListener('change', onScenarioChange);

  return {
    consoleView,
    wizardView,
    view: wizardView,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      scenario.removeEventListener('change', onScenarioChange);
      unsubscribe();
      consoleView.destroy();
      wizardView.destroy();
    }
  };
}

if (typeof document !== 'undefined') {
  bootBatchConsoleFixture(document);
}
